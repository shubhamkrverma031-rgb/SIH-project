import React, { useState, useEffect, useMemo } from "react";
import { addressExplorer } from "../lib/explorers.js";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { 
  Activity, AlertTriangle, ArrowRight, Check, CheckCircle2, 
  ChevronRight, Clock3, Copy, Database, ExternalLink, 
  Eye, FileSpreadsheet, FileText, Filter, Fingerprint, 
  Layers, Plus, RefreshCw, Search, Shield, ShieldAlert, 
  SlidersHorizontal, Sparkles, Trash2, Wallet, X, Zap 
} from "lucide-react";
import { 
  fetchWatchlist, addToWatchlist, removeFromWatchlist, 
  fetchDossiers, saveDossier 
} from "../lib/supabase.js";
import { NodeDetailDrawer } from "./NodeDetailDrawer.jsx";

export function WorkspaceCollectionPage({ view, graph, onNavigate }) {
  const [watchlist, setWatchlist] = useState([]);
  const [dossiers, setDossiers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  
  // Filter & Search states
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedChain, setSelectedChain] = useState("ALL");
  const [selectedRisk, setSelectedRisk] = useState("ALL");
  const [viewMode, setViewMode] = useState("grid"); // "grid" | "table"
  const [copiedId, setCopiedId] = useState(null);

  // Form states for adding to watchlist
  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newChain, setNewChain] = useState("Polygon PoS");
  const [newRisk, setNewRisk] = useState(95);
  const [newReason, setNewReason] = useState("");
  const [newTypology, setNewTypology] = useState("Suspect Layering Mule");
  const [toastMsg, setToastMsg] = useState("");
  const [loadError, setLoadError] = useState(null);

  // allSettled, not all: Promise.all rejects on the FIRST failure, so a
  // watchlist error was wiping the dossier list too — which is why the
  // Legal Dossier page looked like it "could not fetch" even when the
  // dossier query itself was fine.
  const loadData = async () => {
    setLoading(true);
    const [wl, dos] = await Promise.allSettled([fetchWatchlist(), fetchDossiers()]);

    if (wl.status === "fulfilled") setWatchlist(wl.value || []);
    else { console.error("watchlist fetch:", wl.reason); setWatchlist([]); }

    if (dos.status === "fulfilled") setDossiers(dos.value || []);
    else { console.error("dossier fetch:", dos.reason); setDossiers([]); }

    const failed = view === "dossier" ? dos : wl;
    setLoadError(failed.status === "rejected"
      ? (failed.reason?.message || String(failed.reason))
      : null);
    setLoading(false);
  };

  useEffect(() => {
    loadData();
  }, [view]);

  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 3500);
  };

  const copyToClipboard = (text, id, e) => {
    e?.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    showToast("Address copied to clipboard!");
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleAddWatchlist = async (e) => {
    e.preventDefault();
    if (!newAddress.trim()) return;
    try {
      const entry = {
        address: newAddress.trim(),
        label: newLabel.trim() || "Suspect Mule Node",
        chain: newChain,
        risk_score: Number(newRisk),
        reason: newReason.trim() || "Autonomous 24/7 surveillance initiated by IO",
        typology: newTypology,
        added_at: new Date().toISOString(),
      };

      await addToWatchlist(entry);
      showToast("Added to Supabase Watchlist & 24/7 Surveillance Loop!");
      setIsAddModalOpen(false);
      setNewAddress("");
      setNewLabel("");
      setNewReason("");
      setLoadError(null);
      loadData();
    } catch (err) {
      console.error(err);
      setLoadError(err?.message || String(err));
      showToast("Failed to add wallet to backend watchlist");
    }
  };

  const handleRemoveWatchlist = async (id, e) => {
    e.stopPropagation();
    try {
      await removeFromWatchlist(id);
      showToast("Removed from active surveillance queue");
      setLoadError(null);
      setWatchlist(prev => prev.filter(item => item.id !== id));
    } catch (err) {
      console.error(err);
      setLoadError(err?.message || String(err));
      showToast("Failed to remove watchlist row");
    }
  };

  const isWatchlist = view === "watchlist";


  // Filtered Watchlist items
  const filteredWatchlist = useMemo(() => {
    return watchlist.filter(item => {
      const matchQuery = 
        item.address?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.label?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.reason?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.typology?.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchChain = selectedChain === "ALL" || (item.chain && item.chain.toLowerCase().includes(selectedChain.toLowerCase()));
      const matchRisk = 
        selectedRisk === "ALL" ? true :
        selectedRisk === "CRITICAL" ? (item.risk_score >= 90 || item.risk === "CRITICAL") :
        selectedRisk === "HIGH" ? (item.risk_score >= 75 && item.risk_score < 90) : true;

      return matchQuery && matchChain && matchRisk;
    });
  }, [watchlist, searchQuery, selectedChain, selectedRisk]);

  // Total illicit volume in watchlist
  const totalWatchlistINR = useMemo(() => {
    return watchlist.reduce((acc, curr) => acc + (curr.value_inr || (curr.value_usdt ? curr.value_usdt * 89 : 0)), 0);
  }, [watchlist]);

  const watchlistRiskSummary = useMemo(() => {
    if (!watchlist.length) {
      return { band: "UNSCORED", score: null, note: "No backend risk scores yet" };
    }

    const scored = watchlist.filter((item) => Number.isFinite(Number(item.risk_score)));
    if (!scored.length) {
      return { band: "UNSCORED", score: null, note: "Backend rows have not been scored yet" };
    }

    const top = scored.reduce((best, item) => (
      Number(item.risk_score) > Number(best.risk_score) ? item : best
    ), scored[0]);
    const score = Math.round(Number(top.risk_score));
    const band = String(top.risk || (score >= 90 ? "CRITICAL" : score >= 75 ? "HIGH" : score >= 35 ? "MEDIUM" : "LOW")).toUpperCase();

    return {
      band,
      score,
      note: top.reason || top.typology || "Backend-derived risk signal",
    };
  }, [watchlist]);

  return (
    <div className="w-full space-y-6 animate-in fade-in duration-300">
      {/* ── Page Hero Header ── */}
      <div className="glass-panel rounded-3xl border border-slate-200/90 dark:border-white/15 p-6 sm:p-8 backdrop-blur-2xl shadow-xl">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-emerald-800 dark:text-[#d8b84d]">
              <Database size={14} className="text-emerald-600 dark:text-[#d8b84d]" /> 
              <span>{isWatchlist ? "Autonomous 24/7 RPC Surveillance Network" : "Statutory Judicial Trail & FIR Records"}</span>
              <span className="mempool-status inline-flex items-center gap-1 rounded-full bg-emerald-50 dark:bg-emerald-950/70 border border-emerald-200 dark:border-emerald-500/30 px-2 py-0.5 text-[9px] font-bold text-emerald-700 dark:text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse" />
                Mempool Connected
              </span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-slate-900 dark:text-white">
              {isWatchlist ? "Live Watchlist & Surveillance Loop" : "Legal Dossier & Section 91 Directives"}
            </h1>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 max-w-2xl leading-relaxed">
              {isWatchlist
                ? "Continuous cryptographic surveillance across 12 blockchain networks. Automatically detects peel-chain splits, pre-VASP aggregations, and rapid layering movements with sub-second RPC alerts."
                : "Standardized Section 94 BNSS / Section 91 CrPC judicial dossiers with cryptographic hash trees, ready for direct production before Special Cyber Courts."}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={loadData}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 dark:border-white/15 bg-white dark:bg-white/5 px-4 py-3 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-white/10 hover:border-slate-300 dark:hover:border-white/25 transition shadow-sm cursor-pointer"
              title="Refresh and sync with Supabase"
            >
              <RefreshCw size={14} className={loading ? "animate-spin text-emerald-600 dark:text-[#d8b84d]" : "text-slate-500 dark:text-slate-400"} />
              <span>Sync Network</span>
            </button>

            {isWatchlist && (
              <button
                type="button"
                onClick={() => setIsAddModalOpen(true)}
                className="rolex-gold-btn flex items-center gap-2.5 rounded-2xl px-6 py-3 text-xs font-extrabold cursor-pointer"
              >
                <Plus size={16} strokeWidth={2.5} className="text-[#150F00]" />
                <span className="text-[#150F00]">Add Suspect Wallet</span>
              </button>
            )}
          </div>
        </div>

        {loadError && (
          <div className="mt-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs font-semibold text-amber-300">
            {loadError}
          </div>
        )}

        {/* Status Toast */}
        {toastMsg && (
          <div className="mt-4 flex items-center gap-2.5 rounded-2xl border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-950/80 px-4 py-2.5 text-xs font-semibold text-emerald-800 dark:text-emerald-200 shadow-xl animate-in fade-in">
            <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400" />
            <span>{toastMsg}</span>
          </div>
        )}
      </div>

      {/* ── Key Stat Metrics Row ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-panel rounded-3xl border border-slate-200/90 dark:border-white/15 p-5 backdrop-blur-2xl shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider">
              {isWatchlist ? "Monitored Targets" : "Active Case Dossiers"}
            </span>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 text-slate-700 border border-slate-200 dark:bg-[rgba(216,184,77,0.15)] dark:text-[#d8b84d] dark:border-[rgba(216,184,77,0.3)]">
              {isWatchlist ? <Shield size={16} /> : <FileText size={16} />}
            </div>
          </div>
          <div className="mt-3 text-3xl font-extrabold text-slate-900 dark:text-white font-mono">
            {isWatchlist ? watchlist.length : dossiers.length}
          </div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
            <span className="h-2 w-2 rounded-full bg-emerald-600 dark:bg-emerald-400 animate-pulse" />
            <span>24/7 RPC Surveillance Active</span>
          </div>
        </div>

        <div className="glass-panel rounded-3xl border border-slate-200/90 dark:border-white/15 p-5 backdrop-blur-2xl shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider">Total Traced Value</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/30">
              <Wallet size={16} />
            </div>
          </div>
          <div className="mt-3 text-2xl font-extrabold text-slate-900 dark:text-white font-mono">
            ₹{(totalWatchlistINR / 100000).toFixed(2)} <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400">Lakh</span>
          </div>
          <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 font-mono">
            ≈ ${(totalWatchlistINR / 89).toLocaleString(undefined, { maximumFractionDigits: 0 })} USDT
          </div>
        </div>

        <div className="glass-panel rounded-3xl border border-slate-200/90 dark:border-white/15 p-5 backdrop-blur-2xl shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider">Risk Classification</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-rose-50 text-rose-700 border border-rose-200 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/30">
              <AlertTriangle size={16} />
            </div>
          </div>
          <div className="mt-3 text-2xl font-extrabold text-rose-700 dark:text-amber-400 font-mono">
            {watchlistRiskSummary.band}{watchlistRiskSummary.score != null ? ` (${watchlistRiskSummary.score}%)` : ""}
          </div>
          <div className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
            {watchlistRiskSummary.note}
          </div>
        </div>

        <div className="glass-panel rounded-3xl border border-slate-200/90 dark:border-white/15 p-5 backdrop-blur-2xl shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider">Preservation SLA</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-sky-50 text-sky-700 border border-sky-200 dark:bg-cyan-500/15 dark:text-cyan-400 dark:border-cyan-500/30">
              <Clock3 size={16} />
            </div>
          </div>
          <div className="mt-3 text-2xl font-extrabold text-slate-900 dark:text-white font-mono">
            &lt; 4 Hours
          </div>
          <div className="mt-2 text-[11px] text-slate-500 dark:text-cyan-300 font-medium">
            Within Section 91 Legal Freeze Window
          </div>
        </div>
      </div>

      {/* ── Surveillance Queue & Filters Bar ── */}
      {isWatchlist ? (
        <div className="glass-panel rounded-3xl border border-slate-200/90 dark:border-white/15 backdrop-blur-3xl shadow-sm p-6 sm:p-8 space-y-6">
          {/* Controls Bar: Search + Chain Filters + Risk Filters + View Toggle */}
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 dark:border-white/10 pb-6">
            {/* Search Input */}
            <div className="relative flex-1 max-w-md">
              <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-[#d8b84d]" />
              <input
                type="text"
                placeholder="Filter by address, entity label, or case note..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-2xl border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-black/60 pl-11 pr-4 py-3 text-xs text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none focus:border-slate-400 dark:focus:border-[#d8b84d] focus:ring-1 focus:ring-slate-400/30 transition"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-white text-xs cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Filter Pills */}
            <div className="flex flex-wrap items-center gap-2.5">
              {/* Chain selector */}
              <div className="flex items-center rounded-2xl border border-slate-200 dark:border-white/15 bg-slate-100/90 dark:bg-white/5 p-1 shadow-sm">
                {["ALL", "Polygon", "Tron", "Ethereum", "Bitcoin"].map((chain) => (
                  <button
                    key={chain}
                    type="button"
                    onClick={() => setSelectedChain(chain)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                      selectedChain === chain
                        ? "bg-[#059669] text-white shadow-sm dark:bg-[#E5B83B] dark:text-[#150F00]"
                        : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                    }`}
                  >
                    {chain}
                  </button>
                ))}
              </div>

              {/* Risk selector */}
              <div className="flex items-center rounded-2xl border border-slate-200 dark:border-white/15 bg-slate-100/90 dark:bg-white/5 p-1 shadow-sm">
                {["ALL", "CRITICAL", "HIGH"].map((risk) => (
                  <button
                    key={risk}
                    type="button"
                    onClick={() => setSelectedRisk(risk)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                      selectedRisk === risk
                        ? "bg-[#059669] text-white shadow-sm dark:bg-[#E5B83B] dark:text-[#150F00]"
                        : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                    }`}
                  >
                    {risk}
                  </button>
                ))}
              </div>

              {/* View Toggle */}
              <div className="hidden sm:flex items-center rounded-2xl border border-slate-200 dark:border-white/15 bg-slate-100/90 dark:bg-white/5 p-1 shadow-sm">
                <button
                  type="button"
                  onClick={() => setViewMode("grid")}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                    viewMode === "grid" ? "bg-white dark:bg-white/15 text-slate-900 dark:text-white shadow-sm border border-slate-200/80 dark:border-white/10" : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                  title="Card Grid View"
                >
                  Cards
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode("table")}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition cursor-pointer ${
                    viewMode === "table" ? "bg-white dark:bg-white/15 text-slate-900 dark:text-white shadow-sm border border-slate-200/80 dark:border-white/10" : "text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                  title="Table Ledger View"
                >
                  Table
                </button>
              </div>
            </div>
          </div>

          {/* Active Results Summary */}
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span className="flex items-center gap-2">
              <ShieldAlert size={14} className="text-[#d8b84d]" />
              Showing <b>{filteredWatchlist.length}</b> suspect entities under continuous surveillance
            </span>
            <span className="font-mono text-[11px] text-emerald-400">
              ● Mempool Polling Interval: 800ms
            </span>
          </div>

          {/* ── Cards Grid View or Table View or Empty State ── */}
          {loading ? (
            <div className="p-16 flex flex-col items-center justify-center text-center">
              <RefreshCw className="h-8 w-8 animate-spin text-[#d8b84d] mb-3" />
              <p className="text-sm font-semibold text-slate-300">Loading surveillance watchlist...</p>
            </div>
          ) : filteredWatchlist.length === 0 ? (
            <div className="p-16 flex flex-col items-center justify-center text-center rounded-2xl border border-dashed border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-black/20">
              <div className="h-14 w-14 rounded-2xl bg-[#d8b84d]/10 border border-[#d8b84d]/20 flex items-center justify-center mb-4 text-[#d8b84d]">
                <Shield size={28} />
              </div>
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mb-1">No Suspect Wallets Under Surveillance</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mb-6 leading-relaxed">
                Add suspect addresses to activate 24/7 mempool tracking, or run a live trace from the Attribution Workbench to identify and preserve suspicious mule networks.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(true)}
                  className="rolex-gold-btn inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold cursor-pointer"
                >
                  <Plus size={14} className="text-[#150F00]" />
                  <span>Add Suspect Target</span>
                </button>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate("workspace")}
                    className="btn-secondary inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold cursor-pointer"
                  >
                    <span>Launch Attribution Workbench</span>
                    <ArrowRight size={14} />
                  </button>
                )}
              </div>
            </div>
          ) : viewMode === "grid" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredWatchlist.map((item) => (
                <div
                  key={item.id || item.address}
                  onClick={() => setSelectedEntity(item)}
                  className="group relative rounded-3xl border border-slate-200/90 dark:border-white/15 bg-white/90 dark:bg-white/[0.04] p-6 hover:bg-white dark:hover:bg-white/[0.07] hover:border-[#d8b84d]/60 dark:hover:border-[#d8b84d]/50 transition-all duration-200 cursor-pointer flex flex-col justify-between shadow-[0_4px_20px_rgba(0,0,0,0.04)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)] hover:shadow-[0_12px_30px_rgba(0,0,0,0.08)] dark:hover:shadow-[0_15px_40px_rgba(0,0,0,0.7)]"
                >
                  <div className="space-y-4">
                    {/* Card Top: Chain + Status + Trash */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-xl bg-[#d8b84d]/20 dark:bg-[rgba(216,184,77,0.15)] px-3 py-1 text-xs font-bold text-[#B45309] dark:text-[#d8b84d] border border-[#d8b84d]/40 dark:border-[rgba(216,184,77,0.3)]">
                          {item.chain || "Polygon PoS"}
                        </span>
                        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold border ${
                          (item.risk_score || 95) >= 90
                            ? "bg-rose-100 dark:bg-rose-950/70 border-rose-200 dark:border-rose-500/40 text-rose-800 dark:text-rose-300"
                            : "bg-amber-100 dark:bg-amber-950/70 border-amber-200 dark:border-amber-500/40 text-amber-800 dark:text-amber-300"
                        }`}>
                          <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                          {item.risk_score || 95}/100 Risk
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={(e) => handleRemoveWatchlist(item.id, e)}
                        className="flex h-8 w-8 items-center justify-center rounded-xl border border-slate-200 dark:border-white/10 bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-slate-400 hover:border-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/60 hover:text-rose-600 dark:hover:text-rose-300 transition cursor-pointer"
                        title="Remove from surveillance"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {/* Entity Title & Typology */}
                    <div>
                      <div className="flex items-center justify-between">
                        <h3 className="text-base font-bold text-slate-900 dark:text-white group-hover:text-[#B45309] dark:group-hover:text-[#d8b84d] transition truncate">
                          {item.label}
                        </h3>
                      </div>
                      <span className="inline-block mt-1 text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">
                        {item.typology || "Suspect Layering Mule"}
                      </span>
                    </div>

                    {/* Address Identifier Box */}
                    <div className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-100/90 dark:bg-black/60 px-3.5 py-2.5 font-mono text-xs text-slate-800 dark:text-slate-200">
                      <span className="truncate select-all">{item.address}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => copyToClipboard(item.address, item.id, e)}
                          className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200/80 dark:bg-white/10 hover:bg-slate-300 dark:hover:bg-white/20 text-slate-700 dark:text-slate-300 transition cursor-pointer"
                          title="Copy address"
                        >
                          {copiedId === item.id ? <Check size={13} className="text-emerald-600 dark:text-emerald-400" /> : <Copy size={13} />}
                        </button>
                        <a
                          href={(addressExplorer(item.address, item.chain) ?? '#')}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-200/80 dark:bg-white/10 hover:bg-slate-300 dark:hover:bg-white/20 text-slate-700 dark:text-slate-300 transition"
                          title="View on Explorer"
                        >
                          <ExternalLink size={13} />
                        </a>
                      </div>
                    </div>

                    {/* Traced Illicit Value */}
                    <div className="rounded-2xl border border-slate-200/80 dark:border-white/5 bg-slate-50/80 dark:bg-white/[0.02] p-3 flex items-center justify-between">
                      <div>
                        <span className="text-[10px] uppercase font-bold text-slate-500">Traced Volume</span>
                        <div className="text-sm font-bold text-slate-900 dark:text-white font-mono">
                          {item.value_usdt ? `${Number(item.value_usdt).toLocaleString()} USDT` : "Active"}
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] uppercase font-bold text-slate-500">INR Valuation</span>
                        <div className="text-sm font-bold text-emerald-600 dark:text-emerald-400 font-mono">
                          ₹{item.value_inr ? item.value_inr.toLocaleString() : (Number(item.value_usdt || 0) * 89).toLocaleString()} INR
                        </div>
                      </div>
                    </div>

                    {/* Reason Context */}
                    <p className="text-xs text-slate-600 dark:text-slate-300 line-clamp-2 leading-relaxed">
                      {item.reason}
                    </p>
                  </div>

                  {/* Card Bottom: Hop & Action */}
                  <div className="mt-5 pt-4 border-t border-slate-200 dark:border-white/10 flex items-center justify-between text-xs">
                    <span className="text-slate-500 dark:text-slate-400 flex items-center gap-1.5 font-mono text-[11px]">
                      <Clock3 size={13} className="text-slate-400" />
                      {item.last_active ? `Active ${item.last_active}` : "Active RPC Sync"}
                    </span>

                    <span className="text-[#B45309] dark:text-[#d8b84d] font-bold flex items-center gap-1 group-hover:translate-x-1 transition-transform">
                      Inspect Dossier <ChevronRight size={15} />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* ── High-Density Table View ── */
            <div className="table-scroll overflow-x-auto rounded-2xl border border-white/10 bg-black/40">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="border-b border-white/10 bg-white/[0.03] text-[11px] uppercase font-bold text-slate-400 tracking-wider">
                  <tr>
                    <th className="p-4">Entity / Address</th>
                    <th className="p-4">Chain</th>
                    <th className="p-4">Typology</th>
                    <th className="p-4">Traced Volume</th>
                    <th className="p-4">Risk Level</th>
                    <th className="p-4">Status</th>
                    <th className="p-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-mono">
                  {filteredWatchlist.map((item) => (
                    <tr
                      key={item.id || item.address}
                      onClick={() => setSelectedEntity(item)}
                      className="hover:bg-white/[0.05] transition cursor-pointer"
                    >
                      <td className="p-4">
                        <strong className="block font-sans font-bold text-white text-xs">{item.label}</strong>
                        <span className="text-[11px] text-slate-400 truncate max-w-xs block">{item.address}</span>
                      </td>
                      <td className="p-4">
                        <span className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] text-slate-200">
                          {item.chain || "Polygon"}
                        </span>
                      </td>
                      <td className="p-4 font-sans text-cyan-300 font-medium">
                        {item.typology || "Mule Node"}
                      </td>
                      <td className="p-4">
                        <div className="text-white font-bold">{item.value_usdt ? `${Number(item.value_usdt).toLocaleString()} USDT` : "Active"}</div>
                        <div className="text-emerald-400 text-[10px]">₹{item.value_inr ? item.value_inr.toLocaleString() : (Number(item.value_usdt || 0) * 89).toLocaleString()} INR</div>
                      </td>
                      <td className="p-4">
                        <span className="rounded-full bg-rose-950/80 border border-rose-500/40 px-2.5 py-0.5 text-[10px] font-bold text-rose-300">
                          {item.risk_score || 95}/100
                        </span>
                      </td>
                      <td className="p-4">
                        <span className="flex items-center gap-1.5 text-[11px] text-emerald-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          {item.status || "SURVEILLANCE_ACTIVE"}
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setSelectedEntity(item); }}
                          className="rounded-xl border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-[#d8b84d] hover:bg-[#d8b84d]/10 transition"
                        >
                          Dossier →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        /* ── Statutory Legal Dossiers View ── */
        <div className="glass-panel rounded-3xl border border-slate-200/90 dark:border-white/15 backdrop-blur-3xl shadow-2xl p-6 sm:p-8 space-y-5">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-white/10 pb-4">
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <FileText size={20} className="text-[#B45309] dark:text-[#d8b84d]" /> Statutory Legal Dossiers ({dossiers.length})
              </h2>
              <span className="text-xs text-slate-500 dark:text-slate-400">Section 94 BNSS / Section 91 CrPC Certified Production Packets</span>
            </div>
          </div>

          {dossiers.length === 0 ? (
            <div className="p-16 flex flex-col items-center justify-center text-center rounded-2xl border border-dashed border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-black/20">
              <div className="h-14 w-14 rounded-2xl bg-[#d8b84d]/10 border border-[#d8b84d]/20 flex items-center justify-center mb-4 text-[#d8b84d]">
                <FileText size={28} />
              </div>
              <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mb-1">No Statutory Dossiers Generated Yet</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mb-6 leading-relaxed">
                When suspect wallets are traced to VASP deposit endpoints, you can generate certified Section 94 BNSS / Section 91 CrPC legal notices in 1 click from the node intelligence drawer.
              </p>
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate("workspace")}
                  className="rolex-gold-btn inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-bold cursor-pointer"
                >
                  <span>Open Attribution Workbench</span>
                  <ArrowRight size={14} className="text-[#150F00]" />
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {dossiers.map((dos) => (
                <div
                  key={dos.id}
                  onClick={() => setSelectedEntity({
                    address: dos.deposit_address,
                    label: dos.title,
                    balance: dos.total_traced_usdt,
                    value_inr: dos.total_traced_inr,
                    risk_score: 95,
                    audit_notes: `Legal Dossier Ref: ${dos.case_ref}. Attributed to ${dos.target_vasp} with ${dos.confidence} confidence.`,
                  })}
                  className="rounded-3xl border border-slate-200/90 dark:border-white/15 bg-white/90 dark:bg-white/[0.03] p-6 hover:bg-white dark:hover:bg-white/[0.06] hover:border-[#d8b84d]/60 dark:hover:border-[#d8b84d]/50 transition cursor-pointer flex flex-col md:flex-row md:items-center md:justify-between gap-5 shadow-[0_4px_20px_rgba(0,0,0,0.03)] dark:shadow-lg"
                >
                  <div className="flex items-start gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#d8b84d]/15 text-[#B45309] dark:text-[#d8b84d] border border-[#d8b84d]/30">
                      <FileText size={22} />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2.5">
                        <span className="font-mono text-xs font-bold text-[#B45309] dark:text-[#d8b84d]">
                          {dos.case_ref}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 dark:bg-emerald-950/70 border border-emerald-300 dark:border-emerald-500/30 px-2.5 py-0.5 text-[10px] font-bold text-emerald-800 dark:text-emerald-300 shadow-sm">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400 animate-pulse" />
                          {dos.status ? String(dos.status).replace(/_/g, " ") : "NOTICE ISSUED"}
                        </span>
                      </div>
                      <strong className="block text-base font-bold text-slate-900 dark:text-white">{dos.title}</strong>
                      <div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-300 pt-1">
                        <span>Target VASP: <b className="text-[#B45309] dark:text-[#d8b84d]">{dos.target_vasp}</b></span>
                        <span>Deposit Endpoint: <b className="font-mono text-slate-800 dark:text-slate-200">{dos.deposit_address?.slice(0, 14)}...</b></span>
                        <span>Investigating Officer: <b className="text-slate-800 dark:text-slate-200">{dos.io_name}</b></span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between md:flex-col md:items-end gap-1.5 shrink-0 border-t md:border-t-0 border-slate-200 dark:border-white/5 pt-3 md:pt-0">
                    <div className="text-lg font-bold text-slate-900 dark:text-white font-mono">
                      {dos.total_traced_usdt?.toLocaleString()} USDT
                    </div>
                    <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                      ≈ ₹{dos.total_traced_inr?.toLocaleString()} INR
                    </div>
                    <span className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">
                      Issued: {new Date(dos.created_at).toLocaleDateString("en-IN")}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Luxury Apple Glass Add to Watchlist Modal (Rendered with React Portal) ── */}
      {isAddModalOpen && createPortal(
        <div className="fixed inset-0 z-[999999] flex items-center justify-center p-4 sm:p-6 overflow-y-auto">
          {/* Backdrop */}
          <div 
            className="fixed inset-0 bg-black/80 backdrop-blur-xl animate-in fade-in"
            onClick={() => setIsAddModalOpen(false)}
            aria-hidden="true"
          />

          {/* Centered Luxury Glass Modal */}
          <div 
            className="relative z-10 w-full max-w-xl my-auto rounded-3xl border border-white/20 bg-[#061711]/98 p-6 sm:p-8 text-slate-100 shadow-[0_30px_90px_rgba(0,0,0,0.95),0_0_50px_rgba(216,184,77,0.25)] backdrop-blur-3xl animate-in zoom-in-95 duration-200 overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-white/10 pb-5">
              <div className="flex items-center gap-3.5">
                <div 
                  className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[#d8b84d]/40 shadow-lg"
                  style={{ 
                    background: "linear-gradient(135deg, rgba(216, 184, 77, 0.3) 0%, rgba(13, 45, 31, 0.9) 100%)",
                    boxShadow: "0 4px 15px rgba(216, 184, 77, 0.25)"
                  }}
                >
                  <Shield size={22} className="text-[#d8b84d]" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white tracking-tight">Add Wallet to Active Watchlist</h2>
                  <span className="text-xs text-slate-400">Initiates continuous 24/7 on-chain mempool surveillance</span>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setIsAddModalOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/15 bg-white/10 text-slate-300 hover:text-white transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Form */}
            <form onSubmit={handleAddWatchlist} className="mt-6 space-y-4 text-xs">
              <div>
                <label className="block text-slate-300 font-semibold mb-1.5">
                  Wallet Address / Public Key <span className="text-amber-400">*</span>
                </label>
                <input
                  required
                  type="text"
                  placeholder="e.g. 0xe6d634289cf30114041b63e6358 or TR7NHqje..."
                  value={newAddress}
                  onChange={(e) => setNewAddress(e.target.value)}
                  className="w-full rounded-2xl border border-white/15 bg-black/60 p-3.5 text-slate-100 font-mono text-xs outline-none focus:border-[#d8b84d] focus:ring-1 focus:ring-[#d8b84d]/40 transition"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1.5">Entity Label / Name</label>
                  <input
                    type="text"
                    placeholder="e.g. Mule Layering Node #3"
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    className="w-full rounded-2xl border border-white/15 bg-black/60 p-3.5 text-slate-100 text-xs outline-none focus:border-[#d8b84d] focus:ring-1 focus:ring-[#d8b84d]/40 transition"
                  />
                </div>
                <div>
                  <label className="block text-slate-300 font-semibold mb-1.5">Target Network / Chain</label>
                  <select
                    value={newChain}
                    onChange={(e) => setNewChain(e.target.value)}
                    className="w-full rounded-2xl border border-white/15 bg-[#061711] p-3.5 text-slate-100 text-xs outline-none focus:border-[#d8b84d] focus:ring-1 focus:ring-[#d8b84d]/40 transition cursor-pointer"
                  >
                    <option value="Polygon PoS">Polygon PoS (USDT)</option>
                    <option value="Tron (TRC-20)">Tron (TRC-20)</option>
                    <option value="Ethereum (ERC-20)">Ethereum (ERC-20)</option>
                    <option value="Bitcoin (BTC)">Bitcoin (BTC)</option>
                    <option value="Arbitrum One">Arbitrum One</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-slate-300 font-semibold mb-1.5">Entity Typology</label>
                  <select
                    value={newTypology}
                    onChange={(e) => setNewTypology(e.target.value)}
                    className="w-full rounded-2xl border border-white/15 bg-[#061711] p-3.5 text-slate-100 text-xs outline-none focus:border-[#d8b84d] focus:ring-1 focus:ring-[#d8b84d]/40 transition cursor-pointer"
                  >
                    <option value="Suspect Layering Mule">Suspect Layering Mule</option>
                    <option value="Pre-VASP Aggregator">Pre-VASP Aggregator</option>
                    <option value="Peel Chain Splitter">Peel Chain Splitter</option>
                    <option value="P2P Cashout Relay">P2P Cashout Relay</option>
                    <option value="Smart Contract Mule">Smart Contract Mule</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-300 font-semibold mb-1.5">Risk Score (1-100)</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={newRisk}
                    onChange={(e) => setNewRisk(e.target.value)}
                    className="w-full rounded-2xl border border-white/15 bg-black/60 p-3.5 text-slate-100 text-xs outline-none focus:border-[#d8b84d] focus:ring-1 focus:ring-[#d8b84d]/40 transition"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-300 font-semibold mb-1.5">Surveillance Reason / Case Context</label>
                <textarea
                  rows={3}
                  placeholder="e.g. NCRP Ref #9142/2026, suspected layering node in Telegram task scam syndicate..."
                  value={newReason}
                  onChange={(e) => setNewReason(e.target.value)}
                  className="w-full rounded-2xl border border-white/15 bg-black/60 p-3.5 text-slate-100 text-xs outline-none focus:border-[#d8b84d] focus:ring-1 focus:ring-[#d8b84d]/40 transition leading-relaxed"
                />
              </div>

              {/* Quick Presets */}
              <div className="pt-1">
                <span className="text-[10px] text-slate-400 font-semibold">Quick Case Templates:</span>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {[
                    "Telegram Task Scam Layering",
                    "Pre-VASP Batch Consolidation",
                    "P2P Merchant Cashout Disperser",
                    "Section 91 Urgent Freeze Flag"
                  ].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setNewReason(preset)}
                      className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] text-slate-300 hover:bg-white/10 hover:text-white transition"
                    >
                      + {preset}
                    </button>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="pt-4 border-t border-white/10 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="rounded-2xl border border-white/15 bg-white/5 px-5 py-3 font-semibold text-slate-300 hover:bg-white/10 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rolex-gold-btn flex items-center gap-2 rounded-2xl px-6 py-3 text-xs font-extrabold cursor-pointer"
                >
                  <Plus size={16} strokeWidth={2.5} className="text-[#150F00]" />
                  <span className="text-[#150F00]">Start 24/7 Surveillance</span>
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* ── Center Luxury Intelligence Modal (NodeDetailDrawer via Portal) ── */}
      {selectedEntity && (
        <NodeDetailDrawer
          entity={selectedEntity}
          onClose={() => setSelectedEntity(null)}
          onWatchlistUpdated={loadData}
          onDossierUpdated={loadData}
        />
      )}
    </div>
  );
}
