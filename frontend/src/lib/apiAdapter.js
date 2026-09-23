// =====================================================================
// Backend <-> UI adapter.
//
// The UI speaks in human labels ("Polygon PoS (USDT)") and a flat
// {address, chain} request. The backend speaks chain codes and a
// {targets:[...]} contract. Neither should change to suit the other, so the
// translation lives here, in one place.
// =====================================================================

// UI label -> backend chain code. Keys are lowercased before lookup, and
// substring matching covers label variations without another mapping table.
const CHAIN_CODE = {
  polygon: "polygon", matic: "polygon",
  ethereum: "eth", eth: "eth", erc: "eth",
  tron: "tron", trc: "tron",
  bitcoin: "btc", btc: "btc",
  bsc: "bsc", binance: "bsc", bnb: "bsc",
};

export function toChainCode(label) {
  const s = String(label ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["btc", "eth", "polygon", "tron", "bsc"].includes(s)) return s;
  for (const [needle, code] of Object.entries(CHAIN_CODE)) {
    if (s.includes(needle)) return code;
  }
  return null;
}

// Backend node types -> the four the graph component renders.
function nodeType(d) {
  if (d.isTarget) return "SUSPECT";
  if (d.entity === "exchange" || d.hopsToExchange === 0) return "VASP";
  if (d.entity === "mixer" || d.entity === "bridge") return "CONTRACT";
  return "INTERMEDIARY";
}

export function normalizeBackendTrace(payload) {
  const g = payload?.graph ?? {};
  const rawNodes = Array.isArray(g.nodes) ? g.nodes : [];
  const rawEdges = Array.isArray(g.edges) ? g.edges : [];

  const nodes = rawNodes.map((n) => {
    const d = n.data ?? {};
    const riskVal = Number(d.riskScore ?? d.risk_score ?? d.risk ?? n.riskScore ?? n.risk_score ?? n.risk ?? 0);
    const bandVal = (d.riskBand ?? d.risk_band ?? (riskVal >= 80 ? "CRITICAL" : riskVal >= 60 ? "HIGH" : riskVal >= 35 ? "MEDIUM" : "LOW")).toUpperCase();
    return {
      id: d.address ?? n.id,
      label: d.label ?? d.address ?? n.id,
      type: nodeType(d),
      balance: Number(d.inUsd ?? d.in_usd ?? 0) - Number(d.outUsd ?? d.out_usd ?? 0),
      firstSeen: d.firstSeen ?? d.first_seen ?? null,
      risk: riskVal,
      riskScore: riskVal,
      riskBand: bandVal,
      sanctionFloorApplied: !!(d.sanctionFloorApplied ?? d.sanction_floor_applied),
      sanctionFloorReason: d.sanctionFloorReason ?? d.sanction_floor_reason ?? null,
      vaspAttribution: d.vaspAttribution ?? d.vasp_attribution ?? null,
      transactionAggregates: d.transactionAggregates ?? d.transaction_aggregates ?? {},
      txCount: d.degree ?? d.tx_count ?? 0,
      chain: d.chain,
      sanctioned: !!(d.sanctioned ?? d.is_sanctioned),
      hop: d.hop,
      // carried through so the detail drawer can show WHY a wallet scored
      factors: d.factors ?? [],
      narrative: d.narrative ?? null,
      recommendedActions: d.recommendedActions ?? d.recommended_actions ?? [],
      hopsToExchange: d.hopsToExchange ?? d.hops_to_exchange ?? null,
      hopsToSanctioned: d.hopsToSanctioned ?? d.hops_to_sanctioned ?? null,
      explorerUrl: d.explorerUrl ?? d.explorer_url ?? null,
      inUsd: Number(d.inUsd ?? d.in_usd ?? 0),
      outUsd: Number(d.outUsd ?? d.out_usd ?? 0),
    };
  });

  // node ids are backend "chain:address" keys; the UI keys on address alone
  const idToAddress = new Map(rawNodes.map((n) => [n.id, n.data?.address ?? n.id]));

  const edges = rawEdges.map((e) => {
    const d = e.data ?? {};
    return {
      source: idToAddress.get(e.source) ?? e.source,
      target: idToAddress.get(e.target) ?? e.target,
      amount: Number(d.valueUsd ?? 0),
      token: "USD",
      tx_hash: (d.txHashes && d.txHashes[0]) || "",
      txHashes: d.txHashes ?? [],
      explorerUrls: d.explorerUrls ?? [],
      timestamp: d.lastSeen ?? d.firstSeen ?? null,
      txCount: d.txCount ?? 1,
      label: e.label,
      animated: !!e.animated,
      risk: d.risk ?? null,
      riskScore: Number(d.risk?.score ?? d.risk_score ?? 0),
      riskBand: d.risk?.band ?? d.risk_band ?? null,
      relevance: d.relevance ?? null,
      evidence: d.evidence ?? [],
      flags: d.flags ?? [],
      isBridge: !!(d.isBridge ?? d.is_bridge),
      bridgeInfo: d.bridgeInfo ?? d.bridge_info ?? null,
      crossChainTransfer: d.crossChainTransfer ?? d.cross_chain_transfer ?? null,
    };
  });

  // Decoupled VASP Attribution: consume top-level nearestExchange/attribution or look for identified VASP node.
  const backendAttr = payload?.attribution ?? payload?.nearestExchange;

  const vaspNode = nodes.find((n) => (n.vaspAttribution && n.vaspAttribution.identified !== false) || n.type === "VASP");

  const depositEdge = vaspNode
    ? edges.filter((e) => e.target === vaspNode.id).sort((a, b) => b.amount - a.amount)[0]
    : null;

  const attribution = backendAttr
    ? {
        exchange_name: backendAttr.exchange_name ?? backendAttr.vasp_name ?? "Identified Exchange",
        deposit_address: backendAttr.deposit_address ?? vaspNode?.id ?? "",
        hot_wallet_address: backendAttr.deposit_address ?? vaspNode?.id ?? "",
        tx_hash: depositEdge?.tx_hash ?? "",
        deposit_timestamp: depositEdge?.timestamp ?? "",
        confidence: backendAttr.confidence ?? 0.85,
        wallet_type: backendAttr.wallet_type ?? "DEPOSIT",
        case_linked_usd: backendAttr.case_linked_usd ?? 0.0,
        hops: backendAttr.hops ?? vaspNode?.hop ?? 0,
        time_to_attribution_ms: payload?.elapsedMs ?? 0,
        entity_type: "exchange",
        attribution_evidence: backendAttr.evidence ?? [],
      }
    : vaspNode
    ? {
        exchange_name: vaspNode.vaspAttribution?.name ?? (vaspNode.label && vaspNode.label !== vaspNode.id ? vaspNode.label : "Identified Exchange Endpoint"),
        deposit_address: vaspNode.id,
        hot_wallet_address: vaspNode.id,
        tx_hash: depositEdge?.tx_hash ?? "",
        deposit_timestamp: depositEdge?.timestamp ?? "",
        confidence: vaspNode.vaspAttribution?.confidence ?? 0.85,
        wallet_type: vaspNode.vaspAttribution?.wallet_type ?? vaspNode.vaspAttribution?.walletType ?? "DEPOSIT",
        case_linked_usd: vaspNode.inUsd ?? 0.0,
        hops: vaspNode.hop ?? payload?.hops ?? 0,
        time_to_attribution_ms: payload?.elapsedMs ?? 0,
        entity_type: vaspNode.vaspAttribution?.entity_type ?? "exchange",
        attribution_evidence: vaspNode.vaspAttribution?.evidence ?? [],
      }
    : null;

  return {
    nodes,
    edges,
    attribution,
    transactions: payload?.transactions ?? [],
    crossChainTransfers: payload?.crossChainTransfers ?? payload?.cross_chain_transfers ?? [],
    crossChain: payload?.crossChain ?? payload?.cross_chain ?? null,
    stats: payload?.stats ?? null,
    prices: payload?.prices ?? null,
    providerErrors: payload?.providerErrors ?? [],
  };
}
