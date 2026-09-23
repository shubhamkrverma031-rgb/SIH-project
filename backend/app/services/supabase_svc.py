"""
Supabase access: persistence, threat intel, audit, dossier review, ML calls.

Two clients, used deliberately:

  * service client — bypasses RLS. Only for writes the server owns
    (ingested transactions, audit rows, ML predictions).
  * user client — carries the officer's JWT so RLS applies. Used for
    anything read on the officer's behalf, so the database enforces
    need-to-know rather than trusting this process to.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from ..config import Settings
from ..providers.base import NormEdge
from ..security import Officer

log = logging.getLogger("chakravyuh.supabase")


def _chunk(xs: list, n: int) -> list[list]:
    return [xs[i:i + n] for i in range(0, len(xs), n)]


class SupabaseService:
    def __init__(self, cfg: Settings):
        self.cfg = cfg
        self._rest = f"{cfg.supabase_url}/rest/v1"

    def _has_url(self) -> bool:
        return bool(self.cfg.supabase_url)

    # ---- headers ------------------------------------------------------
    def _svc_headers(self) -> dict[str, str]:
        key = self.cfg.supabase_service_role_key
        if not key:
            raise RuntimeError(
                "SUPABASE_SERVICE_ROLE_KEY is not set; server-side writes are disabled"
            )
        return {"apikey": key, "Authorization": f"Bearer {key}",
                "Content-Type": "application/json"}

    def _user_headers(self, token: str) -> dict[str, str]:
        return {"apikey": self.cfg.supabase_anon_key,
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json"}

    # =================================================================
    # Persistence
    # =================================================================
    async def persist_edges(
        self, edges: list[NormEdge], scored_txs: list[dict[str, Any]] | None = None,
    ) -> dict[str, int]:
        if not edges:
            return {"wallets": 0, "transactions": 0}

        tx_score_map: dict[str, dict[str, Any]] = {}
        for stx in (scored_txs or []):
            h = stx.get("tx_hash")
            if h:
                tx_score_map[h] = stx
            k = f"{stx.get('chain')}:{stx.get('from_address')}->{stx.get('to_address')}"
            if k not in tx_score_map:
                tx_score_map[k] = stx

        by_chain: dict[str, list[NormEdge]] = {}
        for e in edges:
            by_chain.setdefault(e.chain, []).append(e)

        wallets = txs = 0
        async with httpx.AsyncClient(timeout=30.0) as c:
            h = self._svc_headers()
            for chain, group in by_chain.items():
                addrs = sorted({a for e in group for a in (e.from_address, e.to_address)})
                for batch in _chunk([{"chain": chain, "address": a} for a in addrs], 500):
                    r = await c.post(
                        f"{self._rest}/wallets", headers={
                            **h, "Prefer": "resolution=ignore-duplicates,return=minimal"},
                        params={"on_conflict": "chain,address"}, json=batch)
                    if r.status_code >= 400:
                        log.error("wallet upsert %s: %s", r.status_code, r.text[:300])
                wallets += len(addrs)

                tx_rows = []
                for e in group:
                    row = e.to_row()
                    k = f"{e.chain}:{e.from_address}->{e.to_address}"
                    sc = tx_score_map.get(e.tx_hash) or tx_score_map.get(k)
                    if sc:
                        risk_obj = sc.get("risk", {})
                        rel_obj = sc.get("relevance", {})
                        row["risk_score"] = risk_obj.get("score")
                        row["risk_band"] = risk_obj.get("band")
                        row["risk_confidence"] = risk_obj.get("confidence")
                        row["relevance_score"] = rel_obj.get("score")
                        row["taint_share"] = rel_obj.get("taint_share")
                        row["risk_factors"] = risk_obj.get("factors", [])
                    tx_rows.append(row)

                for batch in _chunk(tx_rows, 500):
                    r = await c.post(
                        f"{self._rest}/transactions", headers={
                            **h, "Prefer": "resolution=merge-duplicates,return=minimal"},
                        params={"on_conflict":
                                "chain,tx_hash,vout_index,from_address,to_address"},
                        json=batch)
                    if r.status_code >= 400:
                        log.error("tx upsert %s: %s", r.status_code, r.text[:300])
                    else:
                        txs += len(batch)

                await self.rpc("refresh_wallet_stats", {"p_chain": chain})

            await self.rpc("apply_threat_intel", {})

        return {"wallets": wallets, "transactions": txs}

    # =================================================================
    # RPC
    # =================================================================
    async def rpc(self, fn: str, args: dict[str, Any],
                  token: str | None = None) -> Any:
        headers = self._user_headers(token) if token else self._svc_headers()
        async with httpx.AsyncClient(timeout=30.0) as c:
            r = await c.post(f"{self._rest}/rpc/{fn}", headers=headers, json=args)
            if r.status_code >= 400:
                log.error("rpc %s -> %s %s", fn, r.status_code, r.text[:300])
                raise RuntimeError(f"rpc {fn} failed: {r.status_code} {r.text[:200]}")
            return r.json() if r.content else None

    # =================================================================
    # Entity lookups for scoring
    # =================================================================
    async def entity_flags(
        self, chains: list[str], addresses: list[str],
    ) -> tuple[dict[str, dict], dict[str, list[str]]]:
        wallets: dict[str, dict] = {}
        flags: dict[str, list[str]] = {
            "sanctioned": [], "mixers": [], "exchanges": [], "darknet": [], "bridges": [],
        }
        if not addresses:
            return wallets, flags

        async with httpx.AsyncClient(timeout=30.0) as c:
            for batch in _chunk(addresses, 200):
                in_list = ",".join(f'"{a}"' for a in batch)
                r = await c.get(
                    f"{self._rest}/wallets", headers=self._svc_headers(),
                    params={"select": "chain,address,entity_type,vasp_name,is_sanctioned",
                            "chain": f"in.({','.join(chains)})",
                            "address": f"in.({in_list})"})
                if r.status_code >= 400:
                    log.error("wallet lookup %s: %s", r.status_code, r.text[:200])
                    continue
                for w in r.json():
                    wallets[f"{w['chain']}:{w['address']}"] = w
                    if w.get("is_sanctioned"):
                        flags["sanctioned"].append(w["address"])
                    et = w.get("entity_type")
                    if et == "mixer":
                        flags["mixers"].append(w["address"])
                    elif et == "exchange":
                        flags["exchanges"].append(w["address"])
                    elif et == "darknet":
                        flags["darknet"].append(w["address"])
                    elif et == "bridge":
                        flags["bridges"].append(w["address"])
        return wallets, flags

    async def batch_lookup_vasp_intelligence(
        self, chains: list[str], addresses: list[str]
    ) -> dict[str, dict]:
        """
        Batch lookup VASP records, wallet roles, clusters, and evidence across traced wallets.
        Prevents N+1 database queries during trace execution.
        """
        intel_map: dict[str, dict] = {}
        if not addresses or not self._has_url():
            return intel_map

        async with httpx.AsyncClient(timeout=10.0) as c:
            for batch in _chunk(addresses, 200):
                in_list = ",".join(f'"{a}"' for a in batch)
                try:
                    r = await c.get(
                        f"{self._rest}/vasp_wallets",
                        headers=self._svc_headers(),
                        params={
                            "select": "chain,address,wallet_type,label,cluster_id,source,evidence_type,confidence,vasps(id,name,legal_name,entity_type)",
                            "chain": f"in.({','.join(chains)})",
                            "address": f"in.({in_list})",
                            "is_active": "eq.true",
                        },
                    )
                    if r.status_code == 200:
                        for row in r.json():
                            addr = row.get("address")
                            ch = row.get("chain")
                            vasp_info = row.get("vasps") or {}
                            k = f"{ch}:{addr}"
                            intel_map[k] = {
                                "vasp_id": vasp_info.get("id"),
                                "vasp_name": vasp_info.get("name"),
                                "name": vasp_info.get("name"),
                                "entity_type": vasp_info.get("entity_type", "exchange"),
                                "wallet_type": row.get("wallet_type", "DEPOSIT"),
                                "label": row.get("label"),
                                "cluster_id": row.get("cluster_id"),
                                "source": row.get("source"),
                                "is_known_deposit": row.get("wallet_type") == "DEPOSIT",
                                "is_known_hot_wallet": row.get("wallet_type") == "HOT",
                                "is_known_cold_wallet": row.get("wallet_type") == "COLD",
                            }
                except Exception as e:
                    log.warning("vasp_wallets batch query failed: %s", e)

        return intel_map

    async def batch_lookup_bridge_intelligence(
        self, chains: list[str], addresses: list[str]
    ) -> dict[str, dict]:
        """
        Batch lookup bridge contract records and active routes across traced wallets.
        Prevents N+1 database queries during cross-chain trace execution.
        """
        intel_map: dict[str, dict] = {}
        if not addresses or not self._has_url():
            return intel_map

        async with httpx.AsyncClient(timeout=10.0) as c:
            for batch in _chunk(addresses, 200):
                in_list = ",".join(f'"{a}"' for a in batch)
                try:
                    r = await c.get(
                        f"{self._rest}/bridge_contracts",
                        headers=self._svc_headers(),
                        params={
                            "select": "chain,address,role,bridge_id,bridges(id,name,protocol)",
                            "chain": f"in.({','.join(chains)})",
                            "address": f"in.({in_list})",
                            "active": "eq.true",
                        },
                    )
                    if r.status_code == 200:
                        for row in r.json():
                            addr = row.get("address")
                            ch = row.get("chain")
                            bridge_info = row.get("bridges") or {}
                            k = f"{ch}:{addr}"
                            intel_map[k] = {
                                "bridge_id": row.get("bridge_id"),
                                "bridge_name": bridge_info.get("name", "Cross-Chain Bridge"),
                                "protocol": bridge_info.get("protocol", "Bridge"),
                                "role": row.get("role", "ROUTER"),
                            }
                except Exception as e:
                    log.warning("bridge_contracts batch query failed: %s", e)

        return intel_map

    async def persist_cross_chain_transfers(self, transfers: list[Any]) -> int:
        """Persist verified cross-chain bridge transfers to Supabase."""
        if not transfers or not self._has_url():
            return 0

        rows = [t.to_dict() if hasattr(t, "to_dict") else t for t in transfers]
        async with httpx.AsyncClient(timeout=30.0) as c:
            for batch in _chunk(rows, 200):
                try:
                    r = await c.post(
                        f"{self._rest}/cross_chain_transfers",
                        headers={**self._svc_headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
                        json=batch,
                    )
                    if r.status_code >= 400:
                        log.error("cross_chain_transfers insert %s: %s", r.status_code, r.text[:200])
                except Exception as e:
                    log.error("cross_chain_transfers persist failed: %s", e)
        return len(rows)

    async def save_predictions(self, chain: str, scores: dict[str, dict]) -> int:
        rows = [{
            "chain": chain, "address": r.get("address"),
            "risk_score": r.get("risk_score"), "risk_band": r.get("risk_band"),
            "illicit_probability": r.get("illicit_probability"),
            "anomaly_score": r.get("anomaly_score"), "rule_score": r.get("rule_score"),
            "vasp_type": (r.get("vasp_attribution") or {}).get("type"),
            "vasp_confidence": (r.get("vasp_attribution") or {}).get("confidence"),
            "typologies": r.get("typologies", []),
            "explanation": r.get("explanation", []),
            "narrative": r.get("narrative"),
            "recommended_actions": r.get("recommended_actions", []),
            "hops_to_exchange": r.get("hops_to_exchange"),
            "hops_to_sanctioned": r.get("hops_to_sanctioned"),
            "hops_to_mixer": r.get("hops_to_mixer"),
        } for r in scores.values()]
        if not rows:
            return 0
        async with httpx.AsyncClient(timeout=30.0) as c:
            for batch in _chunk(rows, 400):
                r = await c.post(f"{self._rest}/ml_predictions",
                                 headers={**self._svc_headers(), "Prefer": "return=minimal"},
                                 json=batch)
                if r.status_code >= 400:
                    log.error("prediction insert %s: %s", r.status_code, r.text[:300])
                    return 0
        return len(rows)

    # =================================================================
    # Threat intelligence
    # =================================================================
    OFAC_FILES = {
        "sanctioned_addresses_XBT.json": "btc",
        "sanctioned_addresses_ETH.json": "eth",
        "sanctioned_addresses_USDT_TRON.json": "tron",
        "sanctioned_addresses_BSC.json": "bsc",
    }

    async def sync_ofac(self) -> dict[str, Any]:
        total, per_chain, errors = 0, {}, []
        async with httpx.AsyncClient(timeout=30.0) as c:
            for fname, chain in self.OFAC_FILES.items():
                try:
                    r = await c.get(f"{self.cfg.ofac_base_url}/{fname}")
                    if r.status_code != 200:
                        errors.append(f"{fname}: HTTP {r.status_code}")
                        continue
                    addrs = r.json()
                    if not isinstance(addrs, list):
                        errors.append(f"{fname}: unexpected shape")
                        continue
                except Exception as e:                      # noqa: BLE001
                    errors.append(f"{fname}: {e}")
                    continue

                rows = [{
                    "chain": chain,
                    "address": a.lower() if chain in ("eth", "bsc") else a,
                    "source": "OFAC_SDN", "category": "sanctioned",
                    "entity_name": "OFAC SDN listed", "severity": 100,
                    # cite the official register, not the mirror
                    "reference_url": "https://sanctionssearch.ofac.treas.gov/",
                } for a in addrs]

                for batch in _chunk(rows, 500):
                    rr = await c.post(
                        f"{self._rest}/threat_intel",
                        headers={**self._svc_headers(),
                                 "Prefer": "resolution=merge-duplicates,return=minimal"},
                        params={"on_conflict": "chain,address,source"}, json=batch)
                    if rr.status_code >= 400:
                        errors.append(f"{chain} upsert: {rr.text[:150]}")
                per_chain[chain] = len(rows)
                total += len(rows)

        applied = 0
        try:
            applied = await self.rpc("apply_threat_intel", {}) or 0
        except Exception as e:                              # noqa: BLE001
            errors.append(f"apply_threat_intel: {e}")

        return {"total": total, "perChain": per_chain,
                "walletsFlagged": applied, "errors": errors}

    # =================================================================
    # Audit — Control 9: the server supplies the actor, never the client
    # =================================================================
    async def append_audit(
        self, token: str, action: str, resource: str,
        resource_id: str | None = None, detail: dict | None = None,
    ) -> None:
        """
        Calls the append_audit RPC with the OFFICER'S token, so the function's
        auth.uid() derives the actor server-side. A client cannot forge
        another officer's identity into the audit trail because it never
        supplies one.
        """
        try:
            await self.rpc("append_audit", {
                # NOTE: the RPC parameter is p_target, not p_resource. PostgREST
            # matches functions by NAMED arguments, so a wrong name is a
            # 404 (PGRST202), not a type error — it looks like the function
            # is missing when it is actually right there.
            "p_action": action, "p_target": resource,
                "p_resource_id": resource_id, "p_detail": detail or {},
            }, token=token)
        except Exception as e:                              # noqa: BLE001
            # Auditing must not break the investigation, but a silent failure
            # is unacceptable in an evidentiary system — log loudly.
            log.error("AUDIT WRITE FAILED action=%s resource=%s: %s",
                      action, resource, e)

    # =================================================================
    # ML service
    # =================================================================
    async def score_with_ml(
        self, chain: str, addresses: list[str], edges: list[NormEdge],
        flags: dict[str, list[str]],
    ) -> dict[str, dict] | None:
        if not self.cfg.ml_api_url:
            return None
        payload = {
            "chain": chain, "addresses": addresses[:200],
            "edges": [{
                "from_address": e.from_address, "to_address": e.to_address,
                "value_usd": e.value_usd,
                "ts": _epoch(e.block_time), "tx_hash": e.tx_hash,
            } for e in edges],
            "sanctioned": flags.get("sanctioned", []),
            "mixers": flags.get("mixers", []),
            "exchanges": flags.get("exchanges", []),
            "darknet": flags.get("darknet", []),
            "bridges": flags.get("bridges", []),
            # explain=False skips SHAP computation which adds ~15-20s.
            # Risk scores, typologies, vasp attribution are still returned.
            # Heuristic factors from score_graph give the officer traceable
            # reasons; SHAP adds model internals on top, not instead.
            "explain": False,
        }
        headers = {}
        if self.cfg.ml_api_key:
            headers["Authorization"] = f"Bearer {self.cfg.ml_api_key}"
        try:
            async with httpx.AsyncClient(timeout=self.cfg.ml_timeout_seconds) as c:
                r = await c.post(
                    f"{self.cfg.ml_api_url.rstrip('/')}/ml/score",
                    headers=headers,
                    json=payload)
                if r.status_code >= 400:
                    log.error("ML service %s: %s", r.status_code, r.text[:300])
                    return None
                return {x["address"]: x for x in r.json().get("results", [])}
        except Exception as e:                              # noqa: BLE001
            log.error("ML service unreachable: %s", e)
            return None


    # =================================================================
    # Batch 5: Real-Time Monitoring & Alerts
    # =================================================================
    async def get_active_monitored_wallets(self) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(
                f"{self._rest}/monitored_wallets",
                headers=self._svc_headers(),
                params={"enabled": "eq.true", "select": "*"}
            )
            if r.status_code >= 400:
                log.error("get_active_monitored_wallets error %s: %s", r.status_code, r.text)
                return []
            return r.json()

    async def create_monitored_wallet(self, data: dict[str, Any]) -> dict[str, Any] | None:
        async with httpx.AsyncClient(timeout=10.0) as c:
            h = {**self._svc_headers(), "Prefer": "return=representation"}
            r = await c.post(f"{self._rest}/monitored_wallets", headers=h, json=data)
            if r.status_code >= 400:
                log.error("create_monitored_wallet error %s: %s", r.status_code, r.text)
                return None
            res = r.json()
            return res[0] if isinstance(res, list) and res else None

    async def update_monitored_wallet(self, wallet_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        async with httpx.AsyncClient(timeout=10.0) as c:
            h = {**self._svc_headers(), "Prefer": "return=representation"}
            r = await c.patch(
                f"{self._rest}/monitored_wallets",
                headers=h,
                params={"id": f"eq.{wallet_id}"},
                json=updates
            )
            if r.status_code >= 400:
                log.error("update_monitored_wallet error %s: %s", r.status_code, r.text)
                return None
            res = r.json()
            return res[0] if isinstance(res, list) and res else None

    async def delete_monitored_wallet(self, wallet_id: str) -> bool:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.delete(
                f"{self._rest}/monitored_wallets",
                headers=self._svc_headers(),
                params={"id": f"eq.{wallet_id}"}
            )
            return r.status_code < 400

    async def get_monitoring_cursor(self, chain: str, address: str) -> dict[str, Any] | None:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(
                f"{self._rest}/monitoring_cursors",
                headers=self._svc_headers(),
                params={"chain": f"eq.{chain}", "address": f"eq.{address}", "select": "*"}
            )
            if r.status_code >= 400:
                return None
            res = r.json()
            return res[0] if isinstance(res, list) and res else None

    async def update_monitoring_cursor(
        self, chain: str, address: str, block: int, tx_hash: str
    ):
        async with httpx.AsyncClient(timeout=10.0) as c:
            h = {**self._svc_headers(), "Prefer": "resolution=merge-duplicates"}
            row = {
                "chain": chain, "address": address,
                "last_processed_block": block, "last_processed_tx_hash": tx_hash,
                "updated_at": datetime.now(timezone.utc).isoformat()
            }
            await c.post(f"{self._rest}/monitoring_cursors", headers=h, json=row)

    async def persist_alert(self, alert_dict: dict[str, Any]) -> dict[str, Any] | None:
        async with httpx.AsyncClient(timeout=10.0) as c:
            h = {**self._svc_headers(), "Prefer": "resolution=ignore-duplicates,return=representation"}
            r = await c.post(f"{self._rest}/alerts", headers=h, json=alert_dict)
            if r.status_code >= 400:
                log.error("persist_alert error %s: %s", r.status_code, r.text)
                return None
            res = r.json()
            return res[0] if isinstance(res, list) and res else None

    async def get_alerts(
        self,
        case_id: str = "SIH/2026/00412",
        status: str | None = None,
        severity: str | None = None,
        chain: str | None = None,
        limit: int = 100,
        offset: int = 0
    ) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=10.0) as c:
            params: dict[str, str] = {
                "case_id": f"eq.{case_id}",
                "order": "created_at.desc",
                "limit": str(limit),
                "offset": str(offset),
                "select": "*"
            }
            if status:
                params["status"] = f"eq.{status}"
            if severity:
                params["severity"] = f"eq.{severity}"
            if chain:
                params["chain"] = f"eq.{chain}"
            r = await c.get(f"{self._rest}/alerts", headers=self._svc_headers(), params=params)
            if r.status_code >= 400:
                log.error("get_alerts error %s: %s", r.status_code, r.text)
                return []
            return r.json()

    async def get_alert_by_id(self, alert_id: str) -> dict[str, Any] | None:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.get(
                f"{self._rest}/alerts",
                headers=self._svc_headers(),
                params={"id": f"eq.{alert_id}", "select": "*"}
            )
            if r.status_code >= 400:
                return None
            res = r.json()
            return res[0] if isinstance(res, list) and res else None

    async def update_alert_status(
        self, alert_id: str, new_status: str, officer_name: str | None = None
    ) -> dict[str, Any] | None:
        now_iso = datetime.now(timezone.utc).isoformat()
        updates: dict[str, Any] = {"status": new_status}
        if new_status == "ACKNOWLEDGED":
            updates["acknowledged_at"] = now_iso
            updates["acknowledged_by"] = officer_name or "Officer User"
        elif new_status in ("RESOLVED", "DISMISSED"):
            updates["resolved_at"] = now_iso
            updates["resolved_by"] = officer_name or "Officer User"

        async with httpx.AsyncClient(timeout=10.0) as c:
            h = {**self._svc_headers(), "Prefer": "return=representation"}
            r = await c.patch(
                f"{self._rest}/alerts",
                headers=h,
                params={"id": f"eq.{alert_id}"},
                json=updates
            )
            if r.status_code >= 400:
                log.error("update_alert_status error %s: %s", r.status_code, r.text)
                return None
            res = r.json()
            return res[0] if isinstance(res, list) and res else None


def _epoch(iso_ts: str) -> float:
    from datetime import datetime
    try:
        return datetime.fromisoformat(iso_ts.replace("Z", "+00:00")).timestamp()
    except Exception:                                       # noqa: BLE001
        return 0.0


_svc: SupabaseService | None = None


def get_supabase(cfg: Settings) -> SupabaseService:
    global _svc
    if _svc is None:
        _svc = SupabaseService(cfg)
    return _svc
