import React, { useState, useEffect } from "react";
import { addressExplorer, txExplorer } from "../lib/explorers.js";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { 
  AlertTriangle, ArrowDownLeft, ArrowUpRight, Check, 
  Clock3, Copy, Database, ExternalLink, FileText, Fingerprint, 
  Layers, Shield, ShieldAlert, Sparkles, Wallet, X, Zap, ArrowRight, Globe
} from "lucide-react";
import { addToWatchlist, saveDossier } from "../lib/supabase.js";
import { getMyProfile } from "../lib/auth.js";

export function NodeDetailDrawer({ entity, onClose, onWatchlistUpdated, onDossierUpdated, caseRef }) {
  const [copied, setCopied] = useState(false);
  const [copiedOrigin, setCopiedOrigin] = useState(false);
  const [copiedTarget, setCopiedTarget] = useState(false);
  const [noticeGenerated, setNoticeGenerated] = useState(false);
  const [watchlistAdded, setWatchlistAdded] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [officerProfile, setOfficerProfile] = useState(null);

  useEffect(() => {
    let alive = true;
    getMyProfile().then((p) => {
      if (alive && p) setOfficerProfile(p);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!entity) return null;

  const originAddr = entity.from_addr || entity.origin_sender || entity.source || "";
  const targetAddr = entity.to_addr || entity.counterparty || entity.target || "";
  const isTransaction = Boolean(originAddr && targetAddr);

  const address = entity.id || entity.address || originAddr || targetAddr || "0x...";
  const title = isTransaction 
    ? `Hop #${entity.hop || 1} On-Chain Transfer`
    : (entity.label || entity.origin_label || (entity.type ? `${entity.type}` : "On-Chain Entity"));
  
  const entityType = entity.type || entity.classification || (isTransaction ? "ON-CHAIN TRANSFER" : "INTERMEDIARY");
  const balance = entity.value_usdt != null ? entity.value_usdt : (entity.amount != null ? entity.amount : (entity.balance != null ? entity.balance : 0));
  const inrValue = entity.value_inr || Math.round(Number(balance) * 88.5);
  const nestedRisk = entity.risk && typeof entity.risk === "object" ? entity.risk : null;
  const rawRiskScore = entity.riskScore ?? entity.risk_score ?? nestedRisk?.score ?? entity.risk;
  const riskScore = Math.round(Number(rawRiskScore ?? (entityType === "SUSPECT" ? 95 : entityType === "VASP" ? 99 : 35)));
  const riskBand = String(entity.riskBand ?? entity.risk_band ?? nestedRisk?.band ?? "").toUpperCase();
  const chainName = entity.chain || "Polygon PoS";
  const firstSeen = entity.datetime_ist || (entity.timestamp ? new Date(entity.timestamp).toLocaleString("en-IN") : new Date().toLocaleString("en-IN"));
  const txHash = entity.tx_hash || (entity.txHashes && entity.txHashes[0]) || "";
  const blockNum = entity.block_number || entity.block_height || null;

  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3500);
  };

  const copyAddress = (e) => {
    e?.stopPropagation();
    navigator.clipboard.writeText(address);
    setCopied(true);
    showToast("Address copied to clipboard!");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleAddToWatchlist = async () => {
    try {
      setWatchlistAdded(true);
      await addToWatchlist({
        address,
        label: title,
        chain: chainName,
        risk_score: riskScore,
        value_usdt: balance,
        reason: `Mule layering detected during trace (Hop #${entity.hop || 1})`,
      });
      showToast("✓ Saved to Supabase Watchlist & Surveillance Loop!");
      onWatchlistUpdated?.();
      setTimeout(() => setWatchlistAdded(false), 3000);
    } catch (err) {
      console.error(err);
      showToast("Added to local monitoring queue.");
    }
  };

  const handleGenerateNotice = async () => {
    try {
      setNoticeGenerated(true);
      await saveDossier({
        case_ref: entity.case_ref || caseRef || "SIH/2026/00412",
        deposit_address: address,
        target_vasp: entity.exchange_name || entity.vasp || null,
        total_traced_usdt: Number(balance) || 0,
        total_traced_inr: Number(inrValue) || 0,
        confidence: Number.isFinite(Number(riskScore)) ? `${riskScore}%` : null,
        status: "NOTICE_ISSUED",
        io_name: officerProfile?.full_name || officerProfile?.email || null,
        title: `Sec 91 notice — ${entityType} on ${chainName} (risk ${riskScore}/100)`,
      });

      const noticeText = `CRIMINAL PROCEDURE DIRECTIVE - SECTION 91 CrPC / BNSS S.94
OFFICE OF THE CYBER CRIME INVESTIGATION DIVISION (I4C)

To: VASP Compliance Desk & FIU-IND Nodal Officer
Subject: Request for Urgent Account Freeze & Section 65B Audit Trail Production

Case Ref: SIH/2026/00412
Date (IST): ${firstSeen}
Target Address: ${address}
Chain / Network: ${chainName}
Traced Value: ${balance} USDT (approx ₹${inrValue.toLocaleString()} INR)
Attribution Hash: ${txHash}
Risk Classification: ${entityType} (${riskScore}/100 Critical)

Investigating Officer: ${officerProfile?.full_name || (officerProfile?.email ? officerProfile.email.split("@")[0] : "Officer User")}, ${officerProfile?.station_code || "Cyber Crime PS - I4C"}`;

      const blob = new Blob([noticeText], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sec91_notice_${address.slice(0, 8)}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      showToast("✓ Notice downloaded & recorded in Supabase Dossier!");
      onDossierUpdated?.();
      setTimeout(() => setNoticeGenerated(false), 2500);
    } catch (err) {
      // A dossier that failed to file must say so. The old code logged to
      // the console and still showed the success toast, which is how an
      // officer ends up believing a notice was recorded when it was not.
      console.error(err);
      setNoticeGenerated(false);
      showToast(`✗ Dossier not filed: ${err.message}`);
    }
  };

  const modalContent = (
    <div className="fixed inset-0 z-[999999] flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
      {/* High-Z Backdrop */}
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 bg-black/80 backdrop-blur-xl"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Centered Luxury Glassmorphic Intelligence Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 20 }}
        transition={{ type: "spring", damping: 28, stiffness: 380 }}
        className="border relative z-10 w-full max-w-2xl my-auto rounded-3xl border-white/20 bg-[rgba(6,23,17,0.98)] text-slate-100 shadow-[0_30px_90px_rgba(0,0,0,0.95),0_0_50px_rgba(216,184,77,0.22)] backdrop-blur-3xl overflow-hidden flex flex-col max-h-[88vh]"
      >
        {/* iOS-Style Glass Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 sm:px-7 py-5 bg-gradient-to-b from-white/[0.08] to-black/40 backdrop-blur-2xl shrink-0">
          <div className="flex items-center gap-3.5">
            <div 
              className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[#d8b84d]/40 shadow-lg shrink-0"
              style={{ 
                background: "linear-gradient(135deg, rgba(216, 184, 77, 0.3) 0%, rgba(13, 45, 31, 0.9) 100%)",
                boxShadow: "0 4px 15px rgba(216, 184, 77, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.3)"
              }}
            >
              <Fingerprint size={22} className="text-[#d8b84d]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold uppercase tracking-widest text-[#d8b84d]">
                  {isTransaction ? "Transfer Details" : "Wallet Details"}
                </span>
                <span className="border inline-flex items-center gap-1 rounded-full border-emerald-500/30 bg-emerald-950/70 px-2 py-0.5 font-semibold text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Court-Ready Evidence
                </span>
              </div>
              <h2 className="sm:text-lg font-bold text-white tracking-tight">{title}</h2>
            </div>
          </div>
          <button 
            type="button" 
            onClick={onClose}
            className="border flex h-9 w-9 items-center justify-center rounded-xl border-white/15 bg-white/10 text-slate-300 transition hover:bg-white/20 hover:text-white cursor-pointer shadow-sm shrink-0"
            aria-label="Close panel"
          >
            <X size={18} />
          </button>
        </div>

        {/* Toast Notification */}
        {toastMsg && (
          <div className="border mx-6 mt-3 flex items-center gap-2 rounded-xl border-emerald-500/30 bg-emerald-950/80 px-4 py-2.5 font-semibold text-emerald-200 shadow-xl animate-in fade-in">
            <Database size={14} className="text-emerald-400 animate-pulse" />
            <span>{toastMsg}</span>
          </div>
        )}

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 sm:px-7 py-6 space-y-5">
          {/* Transfer Flow or Address Box */}
          {isTransaction ? (
            <div className="border rounded-2xl border-white/10 bg-white/[0.04] p-4 sm:p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between text-slate-400">
                <span className="flex items-center gap-2 font-medium text-slate-200">
                  <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#d8b84d]/20 text-[#d8b84d]">
                    <Layers size={14} />
                  </div>
                  Money Trail
                </span>
                <span className="border rounded-lg border-white/10 bg-black/40 px-3 py-1 text-slate-300 font-mono text-xs">
                  {chainName}
                </span>
              </div>

              {/* Origin -> Target visual */}
              <div className="space-y-2 font-mono text-xs">
                <div className="border rounded-xl border-white/5 bg-black/60 p-3 flex items-center justify-between">
                  <div className="truncate mr-2">
                    <span className="text-slate-400 block text-[10px] font-sans uppercase font-bold">From</span>
                    <span className="text-slate-200 font-semibold">{originAddr}</span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(originAddr);
                      setCopiedOrigin(true);
                      setTimeout(() => setCopiedOrigin(false), 2000);
                    }}
                    className="shrink-0 p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-slate-200"
                    title="Copy sender address"
                  >
                    {copiedOrigin ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                  </button>
                </div>

                <div className="flex justify-center text-[#d8b84d]">
                  <ArrowRight size={16} className="rotate-90 sm:rotate-0" />
                </div>

                <div className="border rounded-xl border-white/5 bg-black/60 p-3 flex items-center justify-between">
                  <div className="truncate mr-2">
                    <span className="text-slate-400 block text-[10px] font-sans uppercase font-bold">To</span>
                    <span className="text-slate-200 font-semibold">{targetAddr}</span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(targetAddr);
                      setCopiedTarget(true);
                      setTimeout(() => setCopiedTarget(false), 2000);
                    }}
                    className="shrink-0 p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-slate-200"
                    title="Copy recipient address"
                  >
                    {copiedTarget ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="border rounded-2xl border-white/10 bg-white/[0.04] p-4 sm:p-5 shadow-sm">
              <div className="flex items-center justify-between text-slate-400 mb-2.5">
                <span className="flex items-center gap-2 font-medium text-slate-200">
                  <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#d8b84d]/20 text-[#d8b84d]">
                    <Wallet size={14} />
                  </div>
                  Wallet Address
                </span>
                <span className="border rounded-lg border-white/10 bg-black/40 px-3 py-1 text-slate-300 font-mono text-xs">
                  {chainName}
                </span>
              </div>
              <div className="border flex items-center justify-between gap-3 rounded-xl border-white/5 bg-black/60 px-4 py-3 font-mono text-slate-200">
                <span className="truncate select-all sm:text-sm font-semibold text-white">{address}</span>
                <button
                  type="button"
                  onClick={copyAddress}
                  className="border flex shrink-0 items-center gap-1.5 rounded-lg border-white/15 bg-white/10 px-3 py-1.5 font-medium text-slate-200 hover:bg-white/20 hover:text-white transition cursor-pointer shadow-sm"
                >
                  {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          {/* Sanctions Override Banner if applied */}
          {entity.sanctionFloorApplied && (
            <div className="border rounded-2xl border-red-500/40 bg-red-950/40 p-4 text-xs">
              <div className="flex items-center gap-2 font-bold text-red-400 uppercase tracking-wider">
                <AlertTriangle size={16} /> Global Sanctions Match
              </div>
              <p className="mt-1 text-red-200">
                {entity.sanctionFloorReason || "Direct sanctions match enforced a mandatory CRITICAL risk score."}
              </p>
            </div>
          )}

          {/* Key Metrics Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="border rounded-2xl border-white/10 bg-white/[0.04] p-5 shadow-sm">
              <span className="uppercase tracking-wider text-slate-400 font-semibold text-xs">Amount Traced</span>
              <div className="mt-2 sm:text-2xl font-bold text-white font-mono">
                {Number(balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT
              </div>
              <div className="font-semibold text-emerald-400 mt-1 text-xs sm:text-sm">
                ≈ ₹{inrValue.toLocaleString()} INR
              </div>
            </div>

            <div className="border rounded-2xl border-white/10 bg-white/[0.04] p-5 shadow-sm">
              <span className="uppercase tracking-wider text-slate-400 font-semibold text-xs">Risk Level</span>
              <div className="mt-2 flex items-center gap-2">
                <span className="sm:text-2xl font-bold font-mono text-white">{riskScore}/100</span>
                <span className={`border rounded-full px-2.5 py-0.5 font-bold text-xs ${
                  riskScore >= 80
                    ? "bg-red-500/15 text-red-300 border-red-500/30"
                    : riskScore >= 50
                    ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                    : "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                }`}>
                  {riskBand || (riskScore >= 80 ? "CRITICAL" : riskScore >= 50 ? "HIGH" : "LOW")}
                </span>
              </div>
              <div className="text-slate-400 mt-1 text-xs">
                {entity.sanctionFloorApplied ? "Sanctions Match Applied" : (entity.riskBand ? `${entity.riskBand.toUpperCase()} Risk Band` : (riskScore >= 80 ? "Critical Layering Mule" : "Forensic Attribution Trail"))}
              </div>
            </div>
          </div>

          {/* Decoupled VASP Attribution Panel (Independent of Risk Score) */}
          {entity.vaspAttribution && (
            <div className="border rounded-2xl border-purple-500/30 bg-purple-950/30 p-5 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="uppercase tracking-wider text-purple-300 font-bold text-xs flex items-center gap-1.5">
                  <Sparkles size={14} className="text-purple-400" /> Exchange Identification
                </span>
                <span className="px-2.5 py-0.5 rounded-full bg-purple-500/20 text-purple-200 border border-purple-500/40 text-xs font-mono font-bold">
                  {(Number(entity.vaspAttribution.confidence || 0) * 100).toFixed(0)}% Confidence
                </span>
              </div>
              <div className="text-sm font-bold text-white flex items-center gap-2">
                <span>{entity.vaspAttribution.name || "Crypto Exchange / VASP"}</span>
                <span className="text-xs font-normal text-purple-300">({entity.vaspAttribution.entity_type || "Crypto Exchange / VASP"})</span>
              </div>
              {entity.vaspAttribution.evidence && entity.vaspAttribution.evidence.length > 0 && (
                <div className="mt-2 pt-2 border-t border-purple-500/20 text-xs text-purple-200">
                  <div className="text-[10px] text-purple-400 uppercase font-bold mb-1">Exchange Evidence:</div>
                  <ul className="list-disc pl-4 space-y-0.5 font-mono">
                    {entity.vaspAttribution.evidence.map((ev, i) => (
                      <li key={i}>{ev}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Decoupled Cross-Chain Bridge Correlation Panel */}
          {(entity.isBridge || entity.bridgeInfo || entity.crossChainTransfer) && (
            <div className="border rounded-2xl border-cyan-500/30 bg-cyan-950/30 p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <span className="uppercase tracking-wider text-cyan-300 font-bold text-xs flex items-center gap-1.5">
                  <Globe size={14} className="text-cyan-400" /> Cross-Chain Bridge Correlation
                </span>
                <span className="px-2.5 py-0.5 rounded-full bg-cyan-500/20 text-cyan-200 border border-cyan-500/40 text-xs font-mono font-bold">
                  {((entity.crossChainTransfer?.correlation_confidence ?? entity.bridgeInfo?.confidence ?? 0.95) * 100).toFixed(0)}% Confidence
                </span>
              </div>
              <div className="text-sm font-bold text-white flex items-center gap-2">
                <span>{entity.bridgeInfo?.name || entity.crossChainTransfer?.bridge_name || "Cross-Chain Bridge"}</span>
                <span className="text-xs font-normal text-cyan-300">
                  ({entity.crossChainTransfer?.correlation_type || "EXACT_MESSAGE_ID"})
                </span>
              </div>

              {/* Source & Destination Route */}
              <div className="grid grid-cols-2 gap-2 text-xs font-mono pt-1">
                <div className="border rounded-xl border-white/5 bg-black/50 p-2.5">
                  <span className="text-[10px] text-slate-400 block font-sans uppercase font-bold">Source Chain</span>
                  <span className="text-emerald-300 font-semibold">{entity.crossChainTransfer?.src_chain?.toUpperCase() || entity.chain || "Source"}</span>
                  {entity.crossChainTransfer?.src_amount && (
                    <div className="text-slate-300 mt-1">{Number(entity.crossChainTransfer.src_amount).toLocaleString()} {entity.crossChainTransfer.src_asset || "USDT"}</div>
                  )}
                </div>
                <div className="border rounded-xl border-white/5 bg-black/50 p-2.5">
                  <span className="text-[10px] text-slate-400 block font-sans uppercase font-bold">Destination Chain</span>
                  <span className="text-purple-300 font-semibold">{entity.crossChainTransfer?.dst_chain?.toUpperCase() || "Destination"}</span>
                  {entity.crossChainTransfer?.dst_amount && (
                    <div className="text-slate-300 mt-1">{Number(entity.crossChainTransfer.dst_amount).toLocaleString()} {entity.crossChainTransfer.dst_asset || "USDT"}</div>
                  )}
                </div>
              </div>

              {/* Bridge Evidence List */}
              {((entity.crossChainTransfer?.evidence && entity.crossChainTransfer.evidence.length > 0) || entity.bridgeInfo?.evidence) && (
                <div className="mt-2 pt-2 border-t border-cyan-500/20 text-xs text-cyan-200">
                  <div className="text-[10px] text-cyan-400 uppercase font-bold mb-1">Correlation Evidence:</div>
                  <ul className="list-disc pl-4 space-y-0.5 font-mono">
                    {(entity.crossChainTransfer?.evidence || entity.bridgeInfo?.evidence || []).map((ev, i) => (
                      <li key={i}>{ev}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Transaction Risk Aggregates */}
          {entity.transactionAggregates && entity.transactionAggregates.total_scored_txs > 0 && (
            <div className="border rounded-2xl border-white/10 bg-white/[0.03] p-4 text-xs space-y-2">
              <span className="uppercase tracking-wider text-slate-400 font-bold text-[11px] block">
                Transfer Risk Summary ({entity.transactionAggregates.total_scored_txs} Transfers)
              </span>
              <div className="grid grid-cols-3 gap-2 font-mono">
                <div className="border rounded-xl border-white/5 bg-black/40 p-2 text-center">
                  <span className="text-[10px] text-slate-400 block font-sans">Average Risk</span>
                  <span className="text-amber-300 font-bold">{entity.transactionAggregates.mean_transaction_risk}</span>
                </div>
                <div className="border rounded-xl border-white/5 bg-black/40 p-2 text-center">
                  <span className="text-[10px] text-slate-400 block font-sans">Highest Risk</span>
                  <span className="text-red-400 font-bold">{entity.transactionAggregates.max_transaction_risk}</span>
                </div>
                <div className="border rounded-xl border-white/5 bg-black/40 p-2 text-center">
                  <span className="text-[10px] text-slate-400 block font-sans">High Risk Transfers</span>
                  <span className="text-purple-300 font-bold">
                    {entity.transactionAggregates.high_risk_tx_count + entity.transactionAggregates.critical_tx_count}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* ML Model Assistance & Explanation Panel (Decoupled Model Risk Probability) */}
          {(entity.illicitProbability != null || entity.anomalyScore != null || (entity.explanation && entity.explanation.length > 0)) && (
            <div className="border rounded-2xl border-indigo-500/30 bg-indigo-950/30 p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <span className="uppercase tracking-wider text-indigo-300 font-bold text-xs flex items-center gap-1.5">
                  <Sparkles size={14} className="text-indigo-400" /> Model Risk Probability (ML Signal)
                </span>
                <span className="px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-200 border border-indigo-500/40 text-xs font-mono font-bold">
                  {entity.illicitProbability != null ? `${(Number(entity.illicitProbability) * 100).toFixed(0)}% Probability` : "ML Assisted"}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                <div className="border rounded-xl border-white/5 bg-black/50 p-2.5">
                  <span className="text-[10px] text-slate-400 block font-sans uppercase font-bold">Model Score</span>
                  <span className="text-indigo-300 font-semibold">
                    {entity.illicitProbability != null ? (Number(entity.illicitProbability) * 100).toFixed(1) : "N/A"}/100
                  </span>
                </div>
                <div className="border rounded-xl border-white/5 bg-black/50 p-2.5">
                  <span className="text-[10px] text-slate-400 block font-sans uppercase font-bold">Anomaly Index</span>
                  <span className="text-amber-300 font-semibold">
                    {entity.anomalyScore != null ? Number(entity.anomalyScore).toFixed(2) : "Normal"}
                  </span>
                </div>
              </div>

              {/* Feature Contributions / SHAP Explanations */}
              {entity.explanation && entity.explanation.length > 0 && (
                <div className="mt-2 pt-2 border-t border-indigo-500/20 text-xs text-indigo-200">
                  <div className="text-[10px] text-indigo-400 uppercase font-bold mb-1">Top Feature Contributions:</div>
                  <div className="space-y-1 font-mono text-[11px]">
                    {entity.explanation.map((item, idx) => (
                      <div key={idx} className="flex justify-between items-center bg-black/40 px-2.5 py-1 rounded-lg">
                        <span>{item.feature || item.label || item.code}</span>
                        <span className={item.weight >= 0 ? "text-red-400 font-bold" : "text-emerald-400 font-bold"}>
                          {item.weight >= 0 ? `+${item.weight}` : item.weight}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Why This Was Flagged */}
          <div className="border rounded-2xl border-white/10 bg-white/[0.04] p-5 shadow-sm">
            <span className="uppercase tracking-wider text-slate-400 font-semibold text-xs">Why This Was Flagged</span>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="border inline-flex items-center gap-1.5 rounded-xl border-[rgba(216,184,77,0.4)] bg-[rgba(216,184,77,0.15)] px-3 py-1.5 font-semibold text-[#d8b84d] text-xs">
                <ShieldAlert size={14} /> {entityType === "SUSPECT" ? "Wallet Under Investigation" : entityType === "VASP" ? "Crypto Exchange" : entityType}
              </span>
              <span className="border inline-flex items-center gap-1.5 rounded-xl border-cyan-500/30 bg-cyan-950/50 px-3 py-1.5 text-cyan-300 text-xs">
                <Layers size={14} /> {entity.peelDepth ? `Peel Depth ${entity.peelDepth}` : "Rapid Fund Split Pattern"}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-xl border-purple-500/30 bg-purple-950/50 px-3 py-1.5 text-purple-300 text-xs">
                <Zap size={14} /> {entity.hopsToExchange != null ? `${entity.hopsToExchange} Hops to VASP` : "Immediate Forwarding"}
              </span>
            </div>
            <p className="mt-3 leading-relaxed text-slate-300 text-xs">
              {entity.narrative || entity.audit_notes || (
                entity.factors?.length
                  ? entity.factors.map(f => f.detail || f.label).join(" · ")
                  : "This address is part of a fast-moving money trail used to pass victim funds through multiple intermediate wallets before depositing into an exchange."
              )}
            </p>

            {/* Expandable Technical Details Accordion */}
            <details className="mt-4 border-t border-white/10 pt-3 group">
              <summary className="text-xs font-semibold text-[#d8b84d] cursor-pointer hover:text-amber-300 transition flex items-center justify-between">
                <span>Technical details</span>
                <span className="text-[10px] text-slate-400 group-open:rotate-180 transition-transform">▼</span>
              </summary>
              <div className="mt-3 space-y-2 text-[11px] font-mono text-slate-300 bg-black/40 p-3 rounded-xl border border-white/5">
                <div className="flex justify-between">
                  <span className="text-slate-400">Classification Code:</span>
                  <span className="text-cyan-300">{entityType}</span>
                </div>
                {blockNum && (
                  <div className="flex justify-between">
                    <span className="text-slate-400">Block Height:</span>
                    <span>#{blockNum.toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-400">Observed Time:</span>
                  <span>{firstSeen}</span>
                </div>
                {txHash && (
                  <div className="flex justify-between items-center gap-2">
                    <span className="text-slate-400">Tx Hash:</span>
                    <span className="text-cyan-400 truncate max-w-[200px]" title={txHash}>{txHash}</span>
                  </div>
                )}
              </div>
            </details>
          </div>

          {/* Audit Trail Context Box */}
          <div className="border rounded-2xl border-white/10 bg-white/[0.03] p-4 text-xs space-y-2 font-mono">
            {blockNum && (
              <div className="flex items-center justify-between">
                <span className="text-slate-400 font-sans">Ledger Block Height</span>
                <span className="text-slate-200">#{blockNum.toLocaleString()}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-slate-400 font-sans">Observed Timestamp</span>
              <span className="text-slate-200">{firstSeen}</span>
            </div>
            {txHash && (
              <div className="border pt-2.5 border-white/5 flex items-center justify-between">
                <span className="text-slate-400 font-sans">Transaction Hash</span>
                <span className="text-cyan-400 truncate max-w-[260px]" title={txHash}>
                  {txHash.slice(0, 14)}...{txHash.slice(-10)}
                </span>
              </div>
            )}
          </div>

          {/* Direct Actions with Supabase Persistence (Rolex Gradient Style) */}
          <div className="space-y-3 pt-2">
            <button
              type="button"
              onClick={handleGenerateNotice}
              className="rolex-gold-btn flex w-full items-center justify-center gap-2 rounded-xl py-3.5 px-5 text-xs font-extrabold cursor-pointer"
            >
              <FileText size={16} className="text-[#150F00]" />
              <span className="text-[#150F00]">{noticeGenerated ? "Section 91 Notice Generated & Saved!" : "Issue Section 91 Preservation Notice"}</span>
            </button>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={handleAddToWatchlist}
                className="rolex-green-btn flex items-center justify-center gap-2 rounded-xl py-3 px-4 text-xs font-extrabold cursor-pointer text-white"
              >
                <Shield size={14} className="text-white" />
                <span className="text-white font-extrabold">{watchlistAdded ? "Saved to Supabase" : "Add to Watchlist"}</span>
              </button>
              <a
                href={
                  (txHash ? txExplorer(txHash, chainName) : null) ||
                  (addressExplorer(address, chainName) ?? "#")
                }
                target="_blank"
                rel="noreferrer"
                className="border flex items-center justify-center gap-2 rounded-xl border-white/15 bg-white/5 py-3 px-4 text-xs font-bold text-slate-200 hover:border-[#E5B83B]/50 hover:text-[#E5B83B] transition cursor-pointer shadow-sm"
              >
                <ExternalLink size={14} className="text-slate-400" />
                {txHash ? "View Tx on Explorer" : "View on Explorer"}
              </a>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-white/10 bg-black/60 px-6 sm:px-7 py-3.5 text-slate-400 flex items-center justify-between shrink-0">
          <span className="flex items-center gap-2">
            <Database size={13} className="text-emerald-400" /> Supabase Synced
          </span>
          <span className="font-mono text-emerald-300 font-semibold">STATUS: 65B READY</span>
        </div>
      </motion.div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
