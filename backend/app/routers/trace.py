"""
POST /trace — the authenticated live blockchain trace.

The endpoint the whole platform exists for. No mock path: if the providers
return nothing, this returns 404 with the provider errors attached. It never
substitutes placeholder edges.
"""
from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ..config import Settings, get_settings
from ..schemas import TraceRequest, TraceResponse
from ..security import Officer, rate_limit, require_role
from ..services.supabase_svc import get_supabase
from ..services.risk import score_graph
from ..services.trace import build_graph, trace_multi_hop

log = logging.getLogger("chakravyuh.api.trace")
router = APIRouter(tags=["trace"])


@router.post("/trace", response_model=TraceResponse)
async def trace(
    req: TraceRequest,
    request: Request,
    cfg: Settings = Depends(get_settings),
    officer: Officer = Depends(require_role("analyst")),
    _rl: Officer = Depends(rate_limit(bucket="trace")),
):
    t0 = time.perf_counter()
    sb = get_supabase(cfg)

    # Control 9: audit the intent before doing the work, so an attempt that
    # later fails or times out still leaves a record that it was made.
    token = getattr(request.state, "access_token", None)
    if token:
        await sb.append_audit(
            token, "TRACE_REQUEST", "wallet",
            req.targets[0].address,
            {"targets": [t.model_dump() for t in req.targets], "hops": req.hops},
        )

    hops = min(req.hops, cfg.max_hops)
    cap = min(req.cap_per_address, 100)

    tr = await trace_multi_hop(req.targets, hops, cap, cfg, req.include_unconfirmed)

    if not tr.edges:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            detail={
                "error": "no transactions found for the supplied addresses",
                "hint": "These addresses may be unused, or a provider may be "
                        "unreachable. No placeholder data is returned.",
                "providerErrors": tr.errors,
                "targets": [t.model_dump() for t in req.targets],
            },
        )

    chains = sorted({e.chain for e in tr.edges})
    all_addrs = sorted({a for e in tr.edges for a in (e.from_address, e.to_address)})

    persisted = {"wallets": 0, "transactions": 0}
    wallets: dict = {}
    flags: dict = {}
    vasp_intel: dict = {}
    bridge_intel: dict = {}
    src_b_events: list = []
    dst_b_events: list = []
    cross_transfers: list = []

    if req.persist or req.score:
        try:
            ef_res = await sb.entity_flags(chains, all_addrs)
            if ef_res:
                wallets, flags = ef_res
            vasp_intel = await sb.batch_lookup_vasp_intelligence(chains, all_addrs)
            bridge_intel = await sb.batch_lookup_bridge_intelligence(chains, all_addrs)
        except Exception as e:                              # noqa: BLE001
            log.error("entity/vasp/bridge lookup failed: %s", e)
            tr.errors.append(f"entity lookup unavailable: {e}")

    from ..services.bridge_correlation import (
        extract_bridge_events, correlate_cross_chain_transfers, propagate_cross_chain_attribution
    )
    src_b_events, dst_b_events = extract_bridge_events(tr.edges, bridge_intel)
    cross_transfers = correlate_cross_chain_transfers(src_b_events, dst_b_events)
    cross_transfers = propagate_cross_chain_attribution(
        tr.edges, [t.address for t in req.targets], cross_transfers
    )

    scores: dict = {}
    scored_txs: list = []
    mode = "none"

    if req.score:
        combined_intel = {**wallets, **vasp_intel, **bridge_intel}
        scores, scored_txs = score_graph(
            tr.edges,
            [t.address for t in req.targets],
            sanctioned=set(flags.get("sanctioned", [])),
            mixers=set(flags.get("mixers", [])),
            exchanges=set(flags.get("exchanges", [])),
            darknet=set(flags.get("darknet", [])),
            wallets_intel=combined_intel,
        )
        mode = "heuristic"

    # ---- persistence and ML scoring run concurrently ----------------
    async def _persist() -> tuple[dict, dict, dict]:
        if not req.persist:
            return {"wallets": 0, "transactions": 0}, {}, {}
        try:
            p = await sb.persist_edges(tr.edges)
            w, f = await sb.entity_flags(chains, all_addrs)
            return p, w, f
        except Exception as exc:                        # noqa: BLE001
            log.error("persistence failed: %s", exc)
            tr.errors.append(f"persistence unavailable: {exc}")
            return {"wallets": 0, "transactions": 0}, {}, {}

    async def _ml_score() -> dict | None:
        if not req.score or not cfg.ml_api_url:
            return None
        try:
            target_chain = [t.chain for t in req.targets][0]
            target_addrs = [t.address for t in req.targets]
            score_addrs = target_addrs + [a for a in all_addrs if a not in set(target_addrs)]
            return await sb.score_with_ml(
                target_chain,
                score_addrs,
                [e for e in tr.edges if e.chain == target_chain],
                flags,
            )
        except Exception as exc:                        # noqa: BLE001
            log.error("ML scoring failed: %s", exc)
            return None

    (persist_result, ml_result) = await asyncio.gather(_persist(), _ml_score())
    persisted, wallets, flags = persist_result
    ml = ml_result

    if req.score:
        if ml:
            mode = "ml+heuristic"
            for addr, ml_row in ml.items():
                base = scores.get(addr, {})
                base.update({
                    "risk_score": ml_row.get("risk_score", base.get("risk_score")),
                    "risk_band": ml_row.get("risk_band", base.get("risk_band")),
                    "illicit_probability": ml_row.get("illicit_probability"),
                    "anomaly_score": ml_row.get("anomaly_score"),
                    "typologies": ml_row.get("typologies", []),
                    "vasp_attribution": ml_row.get("vasp_attribution") or base.get("vasp_attribution"),
                    "ml_explanation": ml_row.get("explanation", []),
                })
                if base.get("sanction_floor_applied"):
                    base["risk_score"] = max(base.get("risk_score") or 0, 90.0)
                    base["risk_band"] = "critical"
                scores[addr] = base
        try:
            await sb.save_predictions([t.chain for t in req.targets][0], scores)
        except Exception as e:                      # noqa: BLE001
            log.error("prediction persistence failed: %s", e)

    if req.persist:
        try:
            p_res = await sb.persist_edges(tr.edges, scored_txs=scored_txs)
            if isinstance(p_res, dict):
                persisted = p_res
            if cross_transfers:
                await sb.persist_cross_chain_transfers(cross_transfers)
        except Exception as e:                              # noqa: BLE001
            log.error("persistence failed: %s", e)
            tr.errors.append(f"persistence unavailable: {e}")

    graph = build_graph(tr, req.targets, wallets, scores, scored_txs=scored_txs)

    # Resolve nearest exchange for TraceResponse top-level attribution summary
    from ..services.vasp_intelligence import resolve_nearest_exchange, VaspAttribution
    vasp_map = {}
    for addr, sc in scores.items():
        va = sc.get("vasp_attribution")
        if isinstance(va, dict) and va.get("identified"):
            vasp_map[addr] = VaspAttribution(
                identified=True,
                vasp_id=va.get("vasp_id"),
                vasp_name=va.get("vasp_name") or va.get("name"),
                chain=sc.get("chain"),
                address=addr,
                wallet_type=va.get("wallet_type") or va.get("walletType") or "DEPOSIT",
                confidence=va.get("confidence", 0.85),
                cluster_id=va.get("cluster_id") or va.get("clusterId"),
                evidence=va.get("evidence", []),
            )

    wallet_attrs = {addr: sc.get("fund_attribution", {}) for addr, sc in scores.items()}
    nearest_ex = resolve_nearest_exchange([t.address for t in req.targets], tr.edges, vasp_map, wallet_attrs)

    # Sort edges chronologically descending (newest first) for forensic investigation
    raw_txs = sorted(
        [e.to_row() for e in tr.edges],
        key=lambda r: str(r.get("block_time") or ""),
        reverse=True,
    )

    formatted_cross_transfers = [t.to_dict() for t in cross_transfers]
    cross_chain_summary = {
        "supported": True,
        "correlationsFound": len(cross_transfers),
        "unconfirmedCandidates": max(0, len(src_b_events) - len(cross_transfers)),
        "incomplete": not tr.complete,
    }

    return TraceResponse(
        ok=True, targets=req.targets, hops=hops, chains=chains,
        stats={
            "edgesTraced": len(tr.edges),
            "addressesDiscovered": len(tr.visited),
            "nodes": len(graph["nodes"]), "graphEdges": len(graph["edges"]),
            "totalValueUsd": round(sum(e.value_usd for e in tr.edges), 2),
            "walletsPersisted": persisted["wallets"],
            "transactionsPersisted": persisted["transactions"],
            "scored": len(scores), "scoringMode": mode,
            "complete": tr.complete,
            "addressesUnreachable": len(tr.dropped),
            "upstreamRequests": tr.upstream.get("requests", 0),
            "upstreamCacheHits": tr.upstream.get("cache_hits", 0),
            "rateLimitRetries": tr.upstream.get("rate_limit_retries", 0),
        },
        prices={
            "usd": tr.prices,
            "note": "current spot rate applied to all transfers; "
                    "not historical cost basis",
        },
        providerErrors=tr.errors,
        graph=graph,
        transactions=raw_txs,
        crossChainTransfers=formatted_cross_transfers,
        crossChain=cross_chain_summary,
        nearestExchange=nearest_ex,
        attribution=nearest_ex,
        elapsedMs=int((time.perf_counter() - t0) * 1000),
    )
