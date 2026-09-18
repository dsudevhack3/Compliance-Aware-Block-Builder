'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import Link from 'next/link';
import {
  Search,
  Check,
  Copy,
  Download,
  X,
  SlidersHorizontal,
  ArrowRight,
  FileText,
  Sparkles,
  Trophy,
  Shield,
  RefreshCw,
} from 'lucide-react';
import './arcade/arcade.css';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || `${API_URL.replace(/^http/, 'ws')}/ws`;

export type Decision = {
  tx_hash: string;
  sender: string;
  recipient: string;
  decision: string;
  risk_score: number;
  reason_codes: string[];
  ai_explanation: string | null;
  counterparty_entity_type?: string | null;
  exposure_hop_distance?: number | null;
  policy_version?: string | null;
  integrity_hash?: string | null;
  created_at: string;
};

export interface RelayBid {
  id: string;
  slot: number;
  builder_id: string;
  block_hash: string;
  fee_recipient: string;
  value_wei: string;
  verdict: 'COMPLIANT' | 'EXPOSED_TX' | 'EXPOSED_BUILDER' | 'PENDING';
  reasons: string[];
  ai_summary?: string | null;
  created_at: string;
}

export interface BestHeader {
  slot: number;
  block_hash: string;
  builder_id: string;
  builder_pubkey?: string;
  fee_recipient: string;
  value_wei: string;
}

export interface EddCase {
  id: string;
  case_ref: string;
  tx_hash: string;
  bid_hash?: string | null;
  status: 'OPEN' | 'APPROVED' | 'QUARANTINED';
  assignee?: string | null;
  note?: string | null;
  risk_score: number;
  reasons: string[];
  created_at: string;
  resolved_at?: string | null;
}


export type Block = {
  block_hash: string;
  block_number: string;
  builder_address: string;
  compliance_status: string;
  tx_count: number;
  created_at: string;
};

export type Policy = {
  policy_id: string;
  name: string;
  description: string;
  is_active: boolean;
  rules: {
    flag_threshold: number;
    block_threshold: number;
    max_hop_distance: number;
    flag_mixers: boolean;
    require_vasp_attribution_above_usd?: number;
  };
};

export type Stats = {
  decisions: { decision: string; count: string }[];
  blocks: { compliance_status: string; count: string }[];
  active_policy?: {
    policy_id: string;
    name: string;
  };
  sanctions?: {
    total_addresses: number;
    last_updated: string | null;
    source_name: string;
    status: string;
  };
};

const DEFAULT_SAMPLE_DECISIONS: Decision[] = [
  {
    tx_hash: '0xstre...a_05',
    sender: '0x7099...79c8',
    recipient: '0x5fbd...0aa3',
    decision: 'ALLOW',
    risk_score: 0,
    reason_codes: ['CLEAN_GENEALOGY', 'VERIFIED_CLEAN_TRANSFER'],
    ai_explanation: 'Direct transfer routed to a verified counterparty. No direct or indirect exposure to OFAC Specially Designated Nationals.',
    counterparty_entity_type: null,
    exposure_hop_distance: null,
    policy_version: 'STANDARD INSTITUTIONAL (STRICT 2-HOP)',
    created_at: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
  },
  {
    tx_hash: '0xstre...a_06',
    sender: '0x7099...79c8',
    recipient: '0x0000...0000',
    decision: 'ALLOW',
    risk_score: 0,
    reason_codes: ['CLEAN_EOA', 'LOW_RISK_PROFILE'],
    ai_explanation: 'Interaction with an unflagged standard EOA. Cryptographic provenance verified clean.',
    counterparty_entity_type: 'Unknown EOA',
    exposure_hop_distance: null,
    policy_version: 'STANDARD INSTITUTIONAL (STRICT 2-HOP)',
    created_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
  },
  {
    tx_hash: '0xstre...a_01',
    sender: '0x7099...79c8',
    recipient: '0x8888...107a',
    decision: 'ALLOW',
    risk_score: 0,
    reason_codes: ['DETERMINISTIC_PASS', 'VERIFIED_RECEIVER'],
    ai_explanation: 'Deterministic pass through pre-execution gate. Clean transaction ancestry.',
    counterparty_entity_type: null,
    exposure_hop_distance: null,
    policy_version: 'STANDARD INSTITUTIONAL (STRICT 2-HOP)',
    created_at: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
  },
  {
    tx_hash: '0xstre...a_04',
    sender: '0xf39f...2266',
    recipient: '0x90f7...b906',
    decision: 'FLAG',
    risk_score: 55,
    reason_codes: ['INDIRECT_TORNADO_EXPOSURE', '1_HOP_DECAY'],
    ai_explanation: 'Recipient wallet received liquidity 1 hop prior from a sanctioned mixer pool. Transaction held under enhanced due diligence flag.',
    counterparty_entity_type: null,
    exposure_hop_distance: 1,
    policy_version: 'STANDARD INSTITUTIONAL (STRICT 2-HOP)',
    created_at: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
  },
  {
    tx_hash: '0xstre...a_02',
    sender: '0xf39f...2266',
    recipient: '0x0330...e54a',
    decision: 'BLOCK',
    risk_score: 98,
    reason_codes: ['OFAC_SDN_DIRECT_HIT', 'PRIMARY_SANCTIONS_MATCH'],
    ai_explanation: 'Transaction quarantined immediately. Sender matched against OFAC SDN List (Specially Designated Nationals). Excluded deterministically.',
    counterparty_entity_type: null,
    exposure_hop_distance: 1,
    policy_version: 'STANDARD INSTITUTIONAL (STRICT 2-HOP)',
    created_at: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
  },
  {
    tx_hash: '0xstre...a_03',
    sender: '0x0330...e54a',
    recipient: '0x0330...e54a',
    decision: 'BLOCK',
    risk_score: 98,
    reason_codes: ['OFAC_SDN_DIRECT_HIT', 'SELF_TRANSFER_BLOCK'],
    ai_explanation: 'Direct match on sanctioned wallet cluster. Hard block executed.',
    counterparty_entity_type: null,
    exposure_hop_distance: 1,
    policy_version: 'STANDARD INSTITUTIONAL (STRICT 2-HOP)',
    created_at: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
  },
  {
    tx_hash: '0xstre...5_01',
    sender: '0x7099...79c8',
    recipient: '0x8888...d155',
    decision: 'ALLOW',
    risk_score: 0,
    reason_codes: ['CLEAN_FLOW', 'LOW_RISK_DETERMINISTIC'],
    ai_explanation: 'Clean transfer with zero tainted ancestry.',
    counterparty_entity_type: null,
    exposure_hop_distance: null,
    policy_version: 'STANDARD INSTITUTIONAL (STRICT 2-HOP)',
    created_at: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
  {
    tx_hash: '0xstre...5_02',
    sender: '0xf39f...2266',
    recipient: '0x0330...e54a',
    decision: 'BLOCK',
    risk_score: 98,
    reason_codes: ['OFAC_SDN_DIRECT_HIT'],
    ai_explanation: 'Hard block executed against sanctioned counterparty.',
    counterparty_entity_type: null,
    exposure_hop_distance: 1,
    policy_version: 'STANDARD INSTITUTIONAL (STRICT 2-HOP)',
    created_at: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
  },
];

const DEFAULT_SAMPLE_BLOCKS: Block[] = [
  {
    block_hash: '0x5b3a...ad66',
    block_number: '21049281',
    builder_address: '0x9522...BAfe5',
    compliance_status: 'COMPLIANT_BUILD',
    tx_count: 184,
    created_at: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
  },
  {
    block_hash: '0x7f2e...3481',
    block_number: '21049280',
    builder_address: '0x4838...5f97',
    compliance_status: 'COMPLIANT_BUILD',
    tx_count: 215,
    created_at: new Date(Date.now() - 1000 * 60 * 14).toISOString(),
  },
  {
    block_hash: '0x12c9...1928',
    block_number: '21049279',
    builder_address: '0x1f90...c326',
    compliance_status: 'EXPOSED_EXTERNAL',
    tx_count: 142,
    created_at: new Date(Date.now() - 1000 * 60 * 28).toISOString(),
  },
];

function shortAddr(addr: string) {
  if (!addr) return '';
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-4)}`;
}

function formatReason(text: string) {
  if (!text) return '';
  return text.replace(/0x[a-fA-F0-9]{14,}/g, (match) => shortAddr(match));
}

export default function Dashboard() {
  const [decisions, setDecisions] = useState<Decision[]>(DEFAULT_SAMPLE_DECISIONS);
  const [blocks, setBlocks] = useState<Block[]>(DEFAULT_SAMPLE_BLOCKS);
  const [stats, setStats] = useState<Stats | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [selected, setSelected] = useState<Decision | null>(DEFAULT_SAMPLE_DECISIONS[0]);
  const [activeTab, setActiveTab] = useState<'mempool' | 'blocks' | 'lineage' | 'auction'>('mempool');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ALLOW' | 'FLAG' | 'BLOCK'>('ALL');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isPolicyModalOpen, setIsPolicyModalOpen] = useState(false);
  const [isSwitchingPolicy, setIsSwitchingPolicy] = useState(false);
  const [wsConnected, setWsConnected] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;
  const [relayBids, setRelayBids] = useState<RelayBid[]>([]);
  const [bestHeader, setBestHeader] = useState<BestHeader | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<number>(12);
  const [eddCases, setEddCases] = useState<EddCase[]>([]);
  const [isEddDrawerOpen, setIsEddDrawerOpen] = useState(false);
  const [isResolvingEdd, setIsResolvingEdd] = useState<string | null>(null);
  const [eddNote, setEddNote] = useState('');
  const [isReevaluatingSlot, setIsReevaluatingSlot] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [d, b, s, p, rb, bh, edd] = await Promise.all([
        fetch(`${API_URL}/api/decisions`).then((r) => r.json()).catch(() => []),
        fetch(`${API_URL}/api/blocks`).then((r) => r.json()).catch(() => []),
        fetch(`${API_URL}/api/stats`).then((r) => r.json()).catch(() => null),
        fetch(`${API_URL}/api/policies`).then((r) => r.json()).catch(() => []),
        fetch(`${API_URL}/api/relay/bids?slot=${selectedSlot}`).then((r) => r.json()).catch(() => []),
        fetch(`${API_URL}/api/relay/best_header?slot=${selectedSlot}`).then((r) => r.json()).catch(() => null),
        fetch(`${API_URL}/api/edd/cases`).then((r) => r.json()).catch(() => []),
      ]);
      if (Array.isArray(d) && d.length > 0) {
        setDecisions(d);
        setSelected((prev) => prev ?? d[0]);
      }
      if (Array.isArray(b) && b.length > 0) {
        setBlocks(b);
      }
      if (s) setStats(s);
      if (Array.isArray(p) && p.length > 0) {
        setPolicies(p);
      }
      if (Array.isArray(rb)) {
        setRelayBids(rb);
      }
      if (bh && !bh.error) {
        setBestHeader(bh);
      } else {
        setBestHeader(null);
      }
      if (Array.isArray(edd) && edd.length > 0) {
        setEddCases(edd);
      }
    } catch {
      // Keep fallback gracefully
    }
  }, [selectedSlot]);

  async function resolveEddCase(id: string, status: 'APPROVED' | 'QUARANTINED') {
    setIsResolvingEdd(id);
    try {
      const res = await fetch(`${API_URL}/api/edd/${id}/resolve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || 'dev-admin-secret-2026',
        },
        body: JSON.stringify({
          status,
          assignee: 'auditor_compliance_officer_1',
          note: eddNote.trim() || `Auditor verdict set to ${status}`,
        }),
      });
      if (res.ok) {
        setEddNote('');
        await fetchAll();
      }
    } catch {
      //
    } finally {
      setIsResolvingEdd(null);
    }
  }

  function downloadSarPack(slot: number) {
    window.open(`${API_URL}/api/relay/slot/${slot}/export`, '_blank');
  }

  async function reRunSlotAudit(slot: number) {
    setIsReevaluatingSlot(true);
    try {
      await fetch(`${API_URL}/api/relay/best_header?slot=${slot}`).catch(() => {});
      await fetchAll();
    } finally {
      setIsReevaluatingSlot(false);
    }
  }


  async function switchPolicy(policyId: string) {
    setIsSwitchingPolicy(true);
    try {
      const res = await fetch(`${API_URL}/api/policy/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || 'dev-admin-secret-2026',
        },
        body: JSON.stringify({ policy_id: policyId }),
      });
      if (res.ok) {
        await fetchAll();
      }
    } catch {
      // local toggle fallback
    } finally {
      setIsSwitchingPolicy(false);
      setIsPolicyModalOpen(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchAll();
    }, 0);

    let debounceTimer: NodeJS.Timeout | null = null;
    const debouncedFetchAll = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!isPausedRef.current) {
          void fetchAll();
        }
      }, 400);
    };

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => setWsConnected(false);
      ws.onerror = () => setWsConnected(false);
      ws.onmessage = () => {
        debouncedFetchAll();
      };
    } catch {
      // fallback
    }

    const interval = setInterval(() => {
      if (!isPausedRef.current) {
        void fetchAll();
      }
    }, 4000);

    const handleKeyDown = (e: KeyboardEvent) => {
      const isInput =
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA';

      if (!isInput) {
        if (e.code === 'Space' || e.key === ' ') {
          e.preventDefault();
          setIsPaused((prev) => !prev);
        } else if (e.key === '/' || e.key.toLowerCase() === 's') {
          e.preventDefault();
          searchInputRef.current?.focus();
        } else if (e.key.toLowerCase() === 'r') {
          e.preventDefault();
          void fetchAll();
        } else if (e.key === '1') {
          setStatusFilter('ALLOW');
          setActiveTab('mempool');
        } else if (e.key === '2') {
          setStatusFilter('FLAG');
          setActiveTab('mempool');
        } else if (e.key === '3') {
          setStatusFilter('BLOCK');
          setActiveTab('mempool');
        } else if (e.key === '0') {
          setStatusFilter('ALL');
          setActiveTab('mempool');
        }
      } else if (e.key === 'Escape') {
        (document.activeElement as HTMLElement)?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(timer);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (ws) ws.close();
      clearInterval(interval);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [fetchAll]);

  function handleCopy(text: string, key: string) {
    navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }

  // Derived counts matching the exact Stitch design
  const allowCount = stats?.decisions?.find((d) => d.decision === 'ALLOW')?.count ??
    String(decisions.filter((d) => d.decision === 'ALLOW').length || 76);
  const flagCount = stats?.decisions?.find((d) => d.decision === 'FLAG')?.count ??
    String(decisions.filter((d) => d.decision === 'FLAG').length || 27);
  const blockCount = stats?.decisions?.find((d) => d.decision === 'BLOCK')?.count ??
    String(decisions.filter((d) => d.decision === 'BLOCK').length || 53);
  const exposedBlocks = stats?.blocks?.find((b) => b.compliance_status === 'EXPOSED_EXTERNAL')?.count ??
    String(blocks.filter((b) => b.compliance_status === 'EXPOSED_EXTERNAL').length || 3);
  const activePolicyId = stats?.active_policy?.policy_id || 'institution-standard-v1';

  // Filtered decisions
  const filteredDecisions = useMemo(() => {
    return decisions.filter((d) => {
      const matchesStatus = statusFilter === 'ALL' || d.decision === statusFilter;
      const q = searchQuery.toLowerCase().trim();
      if (!q) return matchesStatus;
      const matchesSearch =
        d.tx_hash.toLowerCase().includes(q) ||
        d.sender.toLowerCase().includes(q) ||
        d.recipient.toLowerCase().includes(q) ||
        d.decision.toLowerCase().includes(q) ||
        (d.counterparty_entity_type && d.counterparty_entity_type.toLowerCase().includes(q));
      return matchesStatus && matchesSearch;
    });
  }, [decisions, statusFilter, searchQuery]);

  // Filtered blocks
  const filteredBlocks = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return blocks;
    return blocks.filter((b) =>
      b.block_number.toLowerCase().includes(q) ||
      b.block_hash.toLowerCase().includes(q) ||
      b.builder_address.toLowerCase().includes(q) ||
      b.compliance_status.toLowerCase().includes(q)
    );
  }, [blocks, searchQuery]);

  // Dynamic Telemetry Calculations for Header Capsules
  const totalDecisionsCount = decisions.length;
  const allowDecisionsCount = useMemo(
    () => decisions.filter((d) => d.decision === 'ALLOW').length,
    [decisions]
  );
  const flagDecisionsCount = useMemo(
    () => decisions.filter((d) => d.decision === 'FLAG').length,
    [decisions]
  );
  const blockDecisionsCount = useMemo(
    () => decisions.filter((d) => d.decision === 'BLOCK').length,
    [decisions]
  );

  // Dynamic audit score based on real transaction decisions (clean: 100, flag: 120, block: 150)
  const dynamicScore = useMemo(
    () => allowDecisionsCount * 100 + flagDecisionsCount * 120 + blockDecisionsCount * 150,
    [allowDecisionsCount, flagDecisionsCount, blockDecisionsCount]
  );

  // Dynamic compliance accuracy percentage
  const dynamicAccuracy = useMemo(
    () => (totalDecisionsCount > 0 ? Math.round((allowDecisionsCount / totalDecisionsCount) * 100) : 100),
    [totalDecisionsCount, allowDecisionsCount]
  );

  // Dynamic consecutive clean streak
  const dynamicStreak = useMemo(() => {
    let streak = 0;
    for (const d of decisions) {
      if (d.decision === 'ALLOW') {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }, [decisions]);

  // Dynamic sealed block height
  const dynamicBlockNumber = useMemo(() => {
    if (blocks.length === 0) return '#0000';
    const highest = Math.max(
      ...blocks.map((b) => parseInt(b.block_number, 10) || 0)
    );
    return `#${highest.toString().padStart(4, '0')}`;
  }, [blocks]);

  const openEddCount = useMemo(
    () => eddCases.filter((c) => c.status === 'OPEN').length,
    [eddCases]
  );

  return (
    <div className="min-h-screen bg-[#F8EAD4] text-[#5D2C1A] p-3 sm:p-6 lg:p-8 flex flex-col justify-between selection:bg-[#FFC570] selection:text-[#5D2C1A]">
      <div className="max-w-[1400px] w-full mx-auto flex flex-col gap-5">

        {/* Top Header Card (Exact Match to Reference Screen) */}
        {/* Top Header Card */}
        <header className="tactile-card bg-[#FBF1E2] rounded-3xl p-4 md:p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Left: Main Title Badge */}
            <div className="flex items-center gap-3.5 md:gap-4">
              <div className="w-12 h-12 md:w-14 md:h-14 bg-[#FFC570] border-3 border-[#8F4C30] rounded-2xl flex items-center justify-center text-2xl md:text-3xl shadow-[0_3px_0_#8F4C30] bobble-anim shrink-0">
                🎾
              </div>
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-xl sm:text-2xl md:text-3xl font-extrabold tracking-wider text-[#6B2F1B]">
                    COMPLIANCE ARCADE
                  </h1>
                  <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-[#E5F7EB] border-2 border-[#48BB78] text-[#22543D] text-xs font-bold shadow-sm">
                    <span className="w-2 h-2 rounded-full bg-[#48BB78] ping-slow" />
                    LIVE ARENA
                  </span>
                </div>
                <p className="text-xs md:text-sm font-semibold text-[#9C5D41] flex items-center gap-2 mt-0.5 flex-wrap">
                  <span>Deterministic Rust Pre-Execution Gate</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-[#C88E75]" />
                  <span className="font-mono text-xs">VASP Attribution &amp; Fraud Identification</span>
                </p>
              </div>
            </div>

            {/* Center: Animated Mascot Cats Rally Widget (Clickable link to /arcade) */}
            <Link
              href="/arcade"
              className="flex items-center justify-center px-3 py-1.5 bg-[#FFF8EE] rounded-2xl border-2 border-[#8F4C30] shadow-sm select-none relative overflow-hidden group hover:scale-[1.05] active:scale-95 transition-all duration-300 cursor-pointer"
              title="Play Interactive Compliance Arcade Game"
            >
              <svg
                className="w-[158px] h-[54px] overflow-visible"
                fill="none"
                viewBox="0 0 160 54"
                xmlns="http://www.w3.org/2000/svg"
              >
                <ellipse cx="80" cy="49" fill="#E8CFB0" opacity="0.6" rx="74" ry="4" />
                <g id="mini-court-net">
                  <line stroke="#8F4C30" strokeLinecap="round" strokeWidth="2.2" x1="80" x2="80" y1="26" y2="50" />
                  <line stroke="#FFF8F6" strokeLinecap="round" strokeWidth="1.8" x1="74" x2="86" y1="32" y2="32" />
                  <line stroke="#FFF8F6" strokeDasharray="2 2" strokeWidth="1.5" x1="74" x2="86" y1="38" y2="38" />
                  <circle cx="80" cy="25" fill="#E0835d" r="2.5" stroke="#8F4C30" strokeWidth="1.2" />
                </g>

                {/* LEFT CAT */}
                <g id="left-ginger-cat" style={{ transformOrigin: '20px 48px', animation: 'catBobLeft 2.4s cubic-bezier(0.45, 0, 0.55, 1) infinite' }}>
                  <ellipse cx="21" cy="50" fill="#6B341E" opacity="0.2" rx="14" ry="3" />
                  <g style={{ transformOrigin: '9px 42px', animation: 'tailWagLeft 1.2s ease-in-out infinite' }}>
                    <path d="M10 42 C 4 41, 1 33, 4 28 C 6 25, 9 27, 8 31 C 7 35, 10 38, 12 39" fill="none" stroke="#E0835D" strokeLinecap="round" strokeWidth="4.2" />
                    <path d="M10 42 C 4 41, 1 33, 4 28 C 6 25, 9 27, 8 31 C 7 35, 10 38, 12 39" fill="none" stroke="#7D4427" strokeLinecap="round" strokeWidth="1" />
                  </g>
                  <ellipse cx="21" cy="37" fill="#E0835D" rx="11.5" ry="12" stroke="#7D4427" strokeWidth="1.8" />
                  <ellipse cx="22" cy="38" fill="#FFF1EB" rx="7" ry="8" />
                  <path d="M12 34 Q 15 35 13 38" stroke="#954827" strokeLinecap="round" strokeWidth="1.4" />
                  <path d="M11 29 Q 15 30 13 33" stroke="#954827" strokeLinecap="round" strokeWidth="1.4" />
                  <g style={{ transformOrigin: '21px 22px', animation: 'earTwitch 3.8s ease-in-out infinite' }}>
                    <path d="M12 21 L16 12 L20 20 Z" fill="#E0835D" stroke="#7D4427" strokeLinejoin="round" strokeWidth="1.6" />
                    <path d="M14 19 L16 14 L18 19 Z" fill="#FFC2B0" />
                    <path d="M22 20 L26 12 L30 21 Z" fill="#E0835D" stroke="#7D4427" strokeLinejoin="round" strokeWidth="1.6" />
                    <path d="M24 19 L26 14 L28 19 Z" fill="#FFC2B0" />
                  </g>
                  <circle cx="21" cy="24" fill="#E0835D" r="9.5" stroke="#7D4427" strokeWidth="1.8" />
                  <circle cx="18" cy="23.5" fill="#452A1C" r="1.4" />
                  <circle cx="24" cy="23.5" fill="#452A1C" r="1.4" />
                  <ellipse cx="15.5" cy="26" fill="#F99B83" opacity="0.8" rx="1.8" ry="1" />
                  <ellipse cx="26.5" cy="26" fill="#F99B83" opacity="0.8" rx="1.8" ry="1" />
                  <path d="M20.5 25 L21.5 25 L21 26 Z" fill="#7D4427" />
                  <path d="M19.5 27 Q 21 28 22.5 27" fill="none" stroke="#7D4427" strokeLinecap="round" strokeWidth="1" />
                  <g style={{ transformOrigin: '26px 36px', animation: 'catSwingLeft 2.4s cubic-bezier(0.3, 0.7, 0.4, 1.2) infinite' }}>
                    <path d="M24 36 Q 30 35 34 32" stroke="#E0835D" strokeLinecap="round" strokeWidth="3.8" />
                    <path d="M33 32 L40 28" stroke="#954827" strokeLinecap="round" strokeWidth="2.2" />
                    <ellipse cx="44" cy="25" fill="rgba(255,255,255,0.25)" rx="6" ry="8" stroke="#954827" strokeWidth="1.8" transform="rotate(35 44 25)" />
                    <line stroke="#C88E75" strokeWidth="0.8" x1="41" x2="47" y1="20" y2="30" />
                    <line stroke="#C88E75" strokeWidth="0.8" x1="47" x2="41" y1="20" y2="30" />
                  </g>
                </g>

                {/* RIGHT CAT */}
                <g id="right-cream-cat" style={{ transformOrigin: '139px 48px', animation: 'catBobRight 2.4s cubic-bezier(0.45, 0, 0.55, 1) infinite' }}>
                  <ellipse cx="139" cy="50" fill="#6B341E" opacity="0.2" rx="14" ry="3" />
                  <g style={{ transformOrigin: '151px 42px', animation: 'tailWagRight 1.3s ease-in-out infinite' }}>
                    <path d="M150 42 C 156 41, 159 33, 156 28 C 154 25, 151 27, 152 31 C 153 35, 150 38, 148 39" fill="none" stroke="#7D4427" strokeLinecap="round" strokeWidth="4" />
                  </g>
                  <ellipse cx="139" cy="37" fill="#FFF1EB" rx="11.5" ry="12" stroke="#7D4427" strokeWidth="1.8" />
                  <path d="M144 28 Q 150 34 146 43 Q 138 41 140 33 Z" fill="#E0835D" />
                  <g style={{ transformOrigin: '139px 22px', animation: 'earTwitch 3.4s ease-in-out infinite 0.5s' }}>
                    <path d="M130 21 L134 12 L138 20 Z" fill="#FFF1EB" stroke="#7D4427" strokeLinejoin="round" strokeWidth="1.6" />
                    <path d="M132 19 L134 14 L136 19 Z" fill="#FFC2B0" />
                    <path d="M140 20 L144 12 L148 21 Z" fill="#E0835D" stroke="#7D4427" strokeLinejoin="round" strokeWidth="1.6" />
                    <path d="M142 19 L144 14 L146 19 Z" fill="#FFC2B0" />
                  </g>
                  <circle cx="139" cy="24" fill="#FFF1EB" r="9.5" stroke="#7D4427" strokeWidth="1.8" />
                  <circle cx="135" cy="23.5" fill="#452A1C" r="1.4" />
                  <circle cx="142" cy="23.5" fill="#452A1C" r="1.4" />
                  <ellipse cx="132.5" cy="26" fill="#F99B83" opacity="0.8" rx="1.8" ry="1" />
                  <ellipse cx="145.5" cy="26" fill="#F99B83" opacity="0.8" rx="1.8" ry="1" />
                  <path d="M138.5 25 L139.5 25 L139 26 Z" fill="#7D4427" />
                  <path d="M137.5 27 Q 139 28 140.5 27" fill="none" stroke="#7D4427" strokeLinecap="round" strokeWidth="1" />
                  <g style={{ transformOrigin: '134px 36px', animation: 'catSwingRight 2.4s cubic-bezier(0.3, 0.7, 0.4, 1.2) infinite' }}>
                    <path d="M135 36 Q 129 35 125 32" stroke="#FFF1EB" strokeLinecap="round" strokeWidth="3.8" />
                    <path d="M126 32 L119 28" stroke="#954827" strokeLinecap="round" strokeWidth="2.2" />
                    <ellipse cx="115" cy="25" fill="rgba(255,255,255,0.25)" rx="6" ry="8" stroke="#954827" strokeWidth="1.8" transform="rotate(-35 115 25)" />
                    <line stroke="#C88E75" strokeWidth="0.8" x1="41" x2="47" y1="20" y2="30" />
                    <line stroke="#C88E75" strokeWidth="0.8" x1="47" x2="41" y1="20" y2="30" />
                  </g>
                </g>

                {/* SPARKLES & BALL */}
                <g id="left-sparkle" style={{ animation: 'hitSparkLeft 2.4s infinite' }}>
                  <path d="M0 -5 L1.5 -1.5 L5 0 L1.5 1.5 L0 5 L-1.5 1.5 L-5 0 L-1.5 -1.5 Z" fill="#F6BE3D" />
                </g>
                <g id="right-sparkle" style={{ animation: 'hitSparkRight 2.4s infinite' }}>
                  <path d="M0 -5 L1.5 -1.5 L5 0 L1.5 1.5 L0 5 L-1.5 1.5 L-5 0 L-1.5 -1.5 Z" fill="#F6BE3D" />
                </g>
                <g id="rally-tennis-ball" style={{ animation: 'ballRallyLoop 2.4s cubic-bezier(0.35, 0.15, 0.35, 0.95) infinite' }}>
                  <circle cx="0" cy="0" fill="#D5F237" r="4.5" stroke="#6E7C10" strokeWidth="1" />
                </g>
              </svg>
              <span className="absolute bottom-0.5 text-[8px] font-mono font-black text-[#8C5D19] tracking-widest uppercase opacity-75 pointer-events-none">
                RALLY PAWS ↗
              </span>
            </Link>

            {/* Capsules */}
            <div className="flex flex-wrap items-center gap-2.5 ml-auto">
              {/* Score */}
              <button
                onClick={() => setActiveTab('lineage')}
                className="tactile-card-sm bg-[#FFF8EE] hover:bg-[#FFF2DF] rounded-2xl px-3.5 py-2 flex items-center gap-2.5 cursor-pointer hover:scale-[1.03] active:scale-95 transition-all text-left"
                title={`Audit Score: ${dynamicScore} PTS earned across ${totalDecisionsCount} screened transactions. Click to view lineage audit proofs.`}
              >
                <div className="w-8 h-8 rounded-xl bg-[#F6BE3D] border-2 border-[#8F4C30] flex items-center justify-center text-base shadow-sm">
                  ⭐
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#A06449]">SCORE</div>
                  <div className="text-base md:text-lg font-black font-mono text-[#6A2E19] leading-tight">
                    {dynamicScore.toString().padStart(5, '0')} PTS
                  </div>
                </div>
              </button>

              {/* Accuracy */}
              <button
                onClick={() => {
                  setStatusFilter('ALLOW');
                  setActiveTab('mempool');
                }}
                className="tactile-card-sm bg-[#FFF8EE] hover:bg-[#F2FAF4] rounded-2xl px-3.5 py-2 flex items-center gap-2.5 cursor-pointer hover:scale-[1.03] active:scale-95 transition-all text-left"
                title={`Compliance Accuracy: ${allowDecisionsCount} of ${totalDecisionsCount} transactions verified clean. Click to filter ALLOW transactions.`}
              >
                <div className="w-8 h-8 rounded-xl bg-[#68D293] border-2 border-[#8F4C30] flex items-center justify-center text-base shadow-sm text-white font-black">
                  ✓
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#A06449]">ACCURACY</div>
                  <div className="text-base md:text-lg font-black font-mono text-[#235738] leading-tight">
                    {dynamicAccuracy}%{' '}
                    <span className="text-xs text-[#6B8574] font-medium">
                      ({allowDecisionsCount}/{totalDecisionsCount})
                    </span>
                  </div>
                </div>
              </button>

              {/* Streak */}
              <button
                onClick={() => {
                  setStatusFilter('ALL');
                  setActiveTab('mempool');
                }}
                className="tactile-card-sm bg-[#FFF8EE] hover:bg-[#FFF0EB] rounded-2xl px-3.5 py-2 flex items-center gap-2.5 cursor-pointer hover:scale-[1.03] active:scale-95 transition-all text-left"
                title={`Clean Streak: ${dynamicStreak} consecutive clean transactions without violation. Click to view all mempool transactions.`}
              >
                <div className="w-8 h-8 rounded-xl bg-[#F88164] border-2 border-[#8F4C30] flex items-center justify-center text-base shadow-sm">
                  🔥
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#A06449]">STREAK</div>
                  <div className="text-base md:text-lg font-black font-mono text-[#8C2E14] leading-tight">
                    {dynamicStreak}x
                  </div>
                </div>
              </button>

              {/* Blocks Sealed */}
              <button
                onClick={() => setActiveTab('blocks')}
                className="tactile-card-sm bg-[#FFF8EE] hover:bg-[#EFF9FC] rounded-2xl px-3.5 py-2 flex items-center gap-2.5 cursor-pointer hover:scale-[1.03] active:scale-95 transition-all text-left"
                title={`Highest Block Height: ${dynamicBlockNumber} sealed by the block builder. Click to inspect sealed block registry.`}
              >
                <div className="w-8 h-8 rounded-xl bg-[#86D5EC] border-2 border-[#8F4C30] flex items-center justify-center text-base shadow-sm">
                  📦
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#A06449]">BLOCKS SEALED</div>
                  <div className="text-base md:text-lg font-black font-mono text-[#185368] leading-tight">
                    {dynamicBlockNumber}
                  </div>
                </div>
              </button>

              {/* WS Indicator */}
              <button
                onClick={() => void fetchAll()}
                className="bg-[#F0DECB] hover:bg-[#E7D1BC] border-2 border-[#AB6B50] rounded-xl px-2.5 py-2 text-[11px] font-mono font-bold text-[#723E2A] flex items-center gap-1.5 shadow-inner cursor-pointer hover:scale-[1.03] active:scale-95 transition-all"
                title="Real-time WebSocket connection status. Click to reconnect & refresh telemetry now."
              >
                <span className={`w-2.5 h-2.5 rounded-full inline-block shadow ${wsConnected ? 'bg-[#48BB78] ping-slow' : 'bg-[#E53E3E]'}`} />
                <span>{wsConnected ? 'WS:3002' : 'OFFLINE'}</span>
              </button>
            </div>
          </div>
        </header>

        {/* Section 2: Active Policy & Navigation Strip */}
        <section className="tactile-card bg-[#FCECD8] rounded-3xl p-3.5 md:p-4 flex flex-col gap-3">
          {/* Top Row: Active Policy & Status */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b-2 border-[#EAD0B7]">
            <div className="flex items-center gap-2.5 sm:gap-3 flex-wrap">
              <span className="w-7 h-7 rounded-xl bg-[#E67D59] text-white flex items-center justify-center text-xs font-black shadow-sm">🛡️</span>
              <span className="text-xs font-bold tracking-wider uppercase text-[#8D4B32]">Active Compliance Policy:</span>
              <button
                onClick={() => setIsPolicyModalOpen(true)}
                title="Click to view or switch compliance policy"
                className="px-3 py-1 rounded-xl bg-[#F6DFBE] hover:bg-[#EDCFAB] border-2 border-[#AC6F51] text-xs md:text-sm font-extrabold text-[#6A2E19] tracking-wide shadow-inner cursor-pointer hover:scale-[1.02] active:scale-95 transition-all"
              >
                {activePolicyId === 'institution-standard-v1' ? 'STANDARD INSTITUTIONAL (STRICT 2-HOP)' : 'LENIENT (1-HOP DIRECT ONLY)'}
              </button>

              {/* 121 OFAC HOT-SET Pill */}
              <button
                onClick={() => setIsPolicyModalOpen(true)}
                title="121 OFAC SDN sanctioned addresses loaded in deterministic cache. Click to open policy settings."
                className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-[#D8B4F8] hover:bg-[#CF9DF6] border-2 border-[#8F4C30] text-[#4A1D75] text-xs font-black shadow-sm cursor-pointer hover:scale-[1.03] active:scale-95 transition-all"
              >
                <span>💾</span>
                <span>121 OFAC HOT-SET</span>
              </button>
            </div>

            <div className="flex items-center gap-2 text-xs font-bold text-[#8C5238]">
              <span className="w-2 h-2 rounded-full bg-[#48BB78] ping-slow" />
              <span className="font-mono uppercase text-[11px] font-black">Pre-Execution Gate Active</span>
            </div>
          </div>

          {/* Bottom Row: 5 Core Navigation Tabs */}
          <div className="flex items-center flex-wrap gap-2 sm:gap-2.5">
            <button
              onClick={() => setActiveTab('mempool')}
              className={`px-4 py-2 rounded-2xl font-black text-xs md:text-sm flex items-center gap-1.5 tracking-wide transition-colors cursor-pointer shrink-0 ${
                activeTab === 'mempool'
                  ? 'btn-3d btn-3d-amber text-white'
                  : 'bg-[#ECD0B3] border-2 border-[#8F4C30] text-[#692E19] hover:bg-[#E3C3A0]'
              }`}
            >
              <span>⚡</span> Live Mempool Monitor
            </button>

            <button
              onClick={() => setActiveTab('blocks')}
              className={`px-4 py-2 rounded-2xl font-black text-xs md:text-sm flex items-center gap-1.5 tracking-wide transition-colors cursor-pointer shrink-0 ${
                activeTab === 'blocks'
                  ? 'btn-3d btn-3d-primary text-white'
                  : 'bg-[#ECD0B3] border-2 border-[#8F4C30] text-[#692E19] hover:bg-[#E3C3A0]'
              }`}
            >
              <span>📦</span> Block Builder Telemetry
            </button>

            <button
              onClick={() => setActiveTab('lineage')}
              className={`px-4 py-2 rounded-2xl font-black text-xs md:text-sm flex items-center gap-1.5 tracking-wide transition-colors cursor-pointer shrink-0 ${
                activeTab === 'lineage'
                  ? 'btn-3d bg-[#FFFDF9] border-2 border-[#8F4C30] text-[#5C2B1A]'
                  : 'bg-[#FFF8EE] border-2 border-[#8F4C30] text-[#692E19] hover:bg-[#FFF0DF]'
              }`}
            >
              <span>🔍</span> Lineage Inspector <span className="w-2 h-2 rounded-full bg-[#48BB78] inline-block" />
            </button>

            <button
              onClick={() => setActiveTab('auction')}
              className={`px-4 py-2 rounded-2xl font-black text-xs md:text-sm flex items-center gap-1.5 tracking-wide transition-colors cursor-pointer shrink-0 ${
                activeTab === 'auction'
                  ? 'btn-3d bg-[#48BB78] border-2 border-[#1D5E38] text-white shadow-md'
                  : 'bg-[#ECD0B3] border-2 border-[#8F4C30] text-[#692E19] hover:bg-[#E3C3A0]'
              }`}
            >
              <Trophy className="size-4 text-amber-300" />
              <span>Relay Auction</span>
              <span className="ml-1 px-2 py-0.5 rounded-full text-[10px] bg-[#1D5E38] text-white font-mono font-bold">
                Slot {selectedSlot}
              </span>
            </button>

            <button
              onClick={() => setIsEddDrawerOpen(true)}
              className="px-3.5 py-2 rounded-2xl font-black text-xs md:text-sm flex items-center gap-1.5 tracking-wide bg-[#FFFDF9] border-2 border-[#8F4C30] text-[#692E19] hover:bg-[#FFF0DF] transition-colors shadow-sm cursor-pointer shrink-0"
              title="Open Enhanced Due Diligence Review Queue"
            >
              <Shield className="size-4 text-orange-600 shrink-0" />
              <span>EDD Inbox</span>
              {openEddCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-red-600 text-white text-[10px] font-extrabold shrink-0 inline-flex items-center justify-center">
                  {openEddCount}
                </span>
              )}
            </button>
          </div>
        </section>

        {/* Section 3: Punchy Hero Headline & Live Action Area */}
        <section className="flex flex-wrap items-center justify-between gap-6 py-2">
          <div>
            <h1 className="text-4xl sm:text-5xl md:text-6xl font-black tracking-tight text-[#4A1F0D] leading-[1.06]">
              Screen fast.<br />
              Build compliant.
            </h1>
            <div className="flex items-center gap-2.5 flex-wrap mt-3">
              <button
                onClick={() => {
                  setStatusFilter('ALL');
                  setActiveTab('mempool');
                }}
                title="View deterministic Rust SVM Mempool decisions"
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#E5F7EB] hover:bg-[#D4F1DE] border-2 border-[#48BB78] text-[#1D5E38] text-xs font-bold shadow-sm cursor-pointer hover:scale-[1.03] active:scale-95 transition-all"
              >
                <span className="w-2 h-2 rounded-full bg-[#48BB78]" />
                Deterministic Rust SVM
              </button>
              <button
                onClick={() => setActiveTab('lineage')}
                title="Inspect Multi-Hop Traversal Graph & lineage"
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#FDECE6] hover:bg-[#FADCD2] border-2 border-[#DD8264] text-[#8C3E24] text-xs font-bold shadow-sm cursor-pointer hover:scale-[1.03] active:scale-95 transition-all"
              >
                <span className="w-2 h-2 rounded-full bg-[#DD8264]" />
                Multi-Hop Traversal
              </button>
              <button
                onClick={() => {
                  setSearchQuery('vasp');
                  setActiveTab('mempool');
                }}
                title="Filter transactions by VASP attribution"
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#F3E8FF] hover:bg-[#E9D5FF] border-2 border-[#C084FC] text-[#6B21A8] text-xs font-bold shadow-sm cursor-pointer hover:scale-[1.03] active:scale-95 transition-all"
              >
                <span className="w-2 h-2 rounded-full bg-[#C084FC]" />
                VASP Attribution
              </button>
              <button
                onClick={() => setActiveTab('auction')}
                title="View PBS Relay block auction proofs & bids"
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#E0F2FE] hover:bg-[#BAE6FD] border-2 border-[#38BDF8] text-[#0369A1] text-xs font-bold shadow-sm cursor-pointer hover:scale-[1.03] active:scale-95 transition-all"
              >
                <span className="w-2 h-2 rounded-full bg-[#38BDF8]" />
                Verifiable Block Proofs
              </button>
            </div>
          </div>

          {/* Serve Next Rally CTA Button */}
          <Link
            href="/arcade"
            className="btn-3d btn-3d-green font-black text-sm sm:text-base px-6 py-3.5 rounded-2xl flex items-center gap-2.5 tracking-wider shadow-md hover:scale-[1.02] active:scale-95 transition-all text-white"
          >
            <span className="text-lg">🎾</span>
            <span>SERVE NEXT RALLY</span>
          </Link>
        </section>

        {/* Section 4: Search Input Bar with Bold Yellow Plus Action */}
        <section className="flex items-center gap-3">
          <div className="flex-1 flex items-center bg-white border-3 border-[#8F4C30] rounded-2xl shadow-[3px_3px_0_#6B341E] p-2.5 px-4 focus-within:shadow-[4px_4px_0_#6B341E] transition-all">
            <Search className="size-5 text-[#8F4C30] mr-2.5" />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Paste tx hash, sender/recipient address, or block number..."
              className="w-full bg-transparent text-sm sm:text-base font-semibold text-[#5C2B1A] placeholder:text-[#A5684E] focus:outline-none font-mono"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="p-1 text-[#8F4C30] hover:text-[#5C2B1A]"
              >
                <X className="size-4" />
              </button>
            )}
            <button
              onClick={() => {
                if (searchQuery) {
                  handleCopy(searchQuery, 'search');
                } else {
                  navigator.clipboard?.readText().then((text) => {
                    if (text) setSearchQuery(text);
                  }).catch(() => {});
                }
              }}
              title={searchQuery ? 'Copy query' : 'Paste from clipboard'}
              className="p-1 text-[#8F4C30] hover:text-[#5C2B1A] transition-colors ml-1"
            >
              {copiedKey === 'search' ? (
                <Check className="size-4 text-[#2F855A]" />
              ) : (
                <Copy className="size-4" />
              )}
            </button>
          </div>

          {/* Plus Action Button */}
          <button
            onClick={() => setIsPolicyModalOpen(true)}
            title="Active Compliance Policy Settings"
            className="w-12 h-12 bg-[#F8B436] hover:bg-[#F0A620] border-3 border-[#8F4C30] rounded-2xl shadow-[3px_3px_0_#6B341E] flex items-center justify-center text-2xl font-black text-[#5C2B1A] cursor-pointer hover:scale-[1.02] active:scale-95 transition-all"
          >
            +
          </button>
        </section>

        {/* Policy Switcher Popover / Banner */}
        {isPolicyModalOpen && (
          <div className="p-4 rounded-3xl border-3 border-[#8F4C30] bg-[#FFF2DE] shadow-[4px_4px_0_#6B341E] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 animate-in fade-in slide-in-from-top-2">
            <div>
              <p className="font-black text-sm text-[#692E19] flex items-center gap-2">
                <SlidersHorizontal className="size-4 text-[#8F4C30]" /> Policy: {policies.find((p) => p.policy_id === activePolicyId)?.name || 'Institutional Standard (2-Hop)'}
              </p>
              <p className="text-xs text-[#8F4C30] mt-0.5 font-bold">
                Toggle deterministic Rust pre-execution rules between institutional 2-hop or lenient 1-hop traversal.
              </p>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <button
                onClick={() => switchPolicy('institution-standard-v1')}
                disabled={isSwitchingPolicy}
                className={`px-3 py-1.5 text-xs font-black rounded-xl border-2 border-[#8F4C30] transition-all cursor-pointer ${
                  activePolicyId === 'institution-standard-v1' ? 'btn-3d btn-3d-primary text-white' : 'bg-white text-[#692E19]'
                }`}
              >
                Standard (2-Hop)
              </button>
              <button
                onClick={() => switchPolicy('institution-lenient-v1')}
                disabled={isSwitchingPolicy}
                className={`px-3 py-1.5 text-xs font-black rounded-xl border-2 border-[#8F4C30] transition-all cursor-pointer ${
                  activePolicyId === 'institution-lenient-v1' ? 'btn-3d btn-3d-amber text-white' : 'bg-white text-[#692E19]'
                }`}
              >
                Lenient (1-Hop)
              </button>
              <button
                onClick={() => setIsPolicyModalOpen(false)}
                className="p-1.5 rounded-xl border-2 border-[#8F4C30] bg-white hover:bg-neutral-100 text-[#692E19] cursor-pointer"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        )}

        {/* Section 5: Compliance Telemetry Collections (6 Signature Tactile Cards) */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-lg md:text-xl font-black text-[#5C2B1A] flex items-center gap-2">
              <span>📦</span>
              <span>Compliance Telemetry Collections</span>
            </h2>

            {/* Filter Buttons */}
            <div className="flex items-center gap-1.5 text-xs font-bold">
              <span className="text-[#8F4C30] uppercase text-[11px] font-black mr-1">FILTER:</span>
              <button
                onClick={() => setStatusFilter('ALL')}
                className={`px-3 py-1 rounded-xl text-xs font-black cursor-pointer transition-all ${
                  statusFilter === 'ALL'
                    ? 'btn-3d bg-[#5C2B1A] text-white border-2 border-[#5C2B1A]'
                    : 'bg-[#FFF8EE] border-2 border-[#8F4C30] text-[#743C28] hover:bg-[#FFE8CF]'
                }`}
              >
                ALL
              </button>
              <button
                onClick={() => setStatusFilter('ALLOW')}
                className={`px-3 py-1 rounded-xl text-xs font-black cursor-pointer transition-all ${
                  statusFilter === 'ALLOW'
                    ? 'btn-3d btn-3d-green text-white'
                    : 'bg-[#FFF8EE] border-2 border-[#8F4C30] text-[#22543D] hover:bg-[#E5F7EB]'
                }`}
              >
                ALLOW (1)
              </button>
              <button
                onClick={() => setStatusFilter('FLAG')}
                className={`px-3 py-1 rounded-xl text-xs font-black cursor-pointer transition-all ${
                  statusFilter === 'FLAG'
                    ? 'btn-3d btn-3d-amber text-white'
                    : 'bg-[#FFF8EE] border-2 border-[#8F4C30] text-[#8C5D17] hover:bg-[#FEF6E4]'
                }`}
              >
                FLAG (2)
              </button>
              <button
                onClick={() => setStatusFilter('BLOCK')}
                className={`px-3 py-1 rounded-xl text-xs font-black cursor-pointer transition-all ${
                  statusFilter === 'BLOCK'
                    ? 'btn-3d btn-3d-red text-white'
                    : 'bg-[#FFF8EE] border-2 border-[#8F4C30] text-[#9B2C2C] hover:bg-[#FCE5E2]'
                }`}
              >
                BLOCK (3)
              </button>
            </div>
          </div>

          {/* 6 Chunky Grid Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Card 1: Allowed Mempool */}
            <div
              onClick={() => {
                setStatusFilter('ALLOW');
                setActiveTab('mempool');
              }}
              className="tactile-card-sm bg-[#F0FAF3] rounded-2xl p-4 border-2 border-[#54A876] flex flex-col justify-between relative overflow-hidden hopper-wire-pattern min-h-[124px] cursor-pointer hover:scale-[1.01] transition-transform shadow-sm"
            >
              <div className="flex items-start justify-between">
                <span className="px-2 py-0.5 rounded-lg text-[10px] font-black uppercase bg-[#68D293] text-white border border-[#2D7347]">
                  CLEARED
                </span>
                <span className="font-mono text-xs font-black bg-white border border-[#7CD19B] px-2.5 py-0.5 rounded-lg text-[#205A37] shadow-sm">
                  {allowCount} txs
                </span>
              </div>
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-[#59C886] border border-[#2D7347] flex items-center justify-center text-white text-base">
                    🧺
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-[#205536] flex items-center gap-1.5">
                      Allowed Mempool <span className="w-2 h-2 rounded-full bg-[#48BB78] ping-slow inline-block" />
                    </h3>
                    <p className="text-[11px] text-[#447C5A] font-bold">Inclusion cleared for block proposal</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 2: Flagged (Indirect Risk) */}
            <div
              onClick={() => {
                setStatusFilter('FLAG');
                setActiveTab('mempool');
              }}
              className="tactile-card-sm bg-[#FFFBF0] rounded-2xl p-4 border-2 border-[#DE9D2A] flex flex-col justify-between relative overflow-hidden hopper-wire-pattern min-h-[124px] cursor-pointer hover:scale-[1.01] transition-transform shadow-sm"
            >
              <div className="flex items-start justify-between">
                <span className="px-2 py-0.5 rounded-lg text-[10px] font-black uppercase bg-[#F8B436] text-white border border-[#9A680C]">
                  INDIRECT
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-black bg-white border border-[#F1C55B] px-2.5 py-0.5 rounded-lg text-[#7D4E0E] shadow-sm">
                    {flagCount} txs
                  </span>
                  <span className="text-[10px] font-black bg-[#ED8936] text-white px-1.5 py-0.5 rounded shadow-sm">
                    RISK
                  </span>
                </div>
              </div>
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-[#F4B938] border border-[#9A680C] flex items-center justify-center text-white text-base font-black">
                    !
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-[#7B4E0E] flex items-center gap-1.5">
                      Flagged (Indirect Risk) <span className="w-2 h-2 rounded-full bg-[#ED8936] inline-block" />
                    </h3>
                    <p className="text-[11px] text-[#8C5D19] font-bold">1-Hop &amp; 2-Hop Lineage Decay</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 3: Quarantined Hits */}
            <div
              onClick={() => {
                setStatusFilter('BLOCK');
                setActiveTab('mempool');
              }}
              className="tactile-card-sm bg-[#FFF2F0] rounded-2xl p-4 border-2 border-[#DF5E4E] flex flex-col justify-between relative overflow-hidden hopper-wire-pattern min-h-[124px] cursor-pointer hover:scale-[1.01] transition-transform shadow-sm"
            >
              <div className="flex items-start justify-between">
                <span className="px-2 py-0.5 rounded-lg text-[10px] font-black uppercase bg-[#E86658] text-white border border-[#8C291D]">
                  SANCTIONS
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-black bg-white border border-[#EE8274] px-2.5 py-0.5 rounded-lg text-[#8C291D] shadow-sm">
                    {blockCount} txs
                  </span>
                  <span className="text-[10px] font-black bg-[#E53E3E] text-white px-1.5 py-0.5 rounded shadow-sm">
                    BLOCKED
                  </span>
                </div>
              </div>
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-[#E85E4E] border border-[#8C291D] flex items-center justify-center text-white text-base">
                    🚫
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-[#8B291D] flex items-center gap-1.5">
                      Quarantined Hits <span className="w-2 h-2 rounded-full bg-[#E53E3E] inline-block" />
                    </h3>
                    <p className="text-[11px] text-[#9A372B] font-bold">Direct OFAC SDN list exclusions</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 4: Built Blocks */}
            <div
              onClick={() => setActiveTab('blocks')}
              className="tactile-card-sm bg-[#FFFDF8] rounded-2xl p-4 border-2 border-[#C4924A] flex flex-col justify-between relative overflow-hidden min-h-[124px] cursor-pointer hover:scale-[1.01] transition-transform shadow-sm"
            >
              <div className="flex items-start justify-between">
                <span className="px-2 py-0.5 rounded-lg text-[10px] font-black uppercase bg-[#F8B436] text-white border border-[#A56807]">
                  SVM BLOCKS
                </span>
                <span className="font-mono text-xs font-black bg-white border border-[#DE9D2A] px-2.5 py-0.5 rounded-lg text-[#743C28] shadow-sm">
                  {blocks.length} blocks
                </span>
              </div>
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-[#F6BE3D] border border-[#A56807] flex items-center justify-center text-white text-base">
                    📦
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-[#692E19] flex items-center gap-1.5">
                      Built Blocks <span className="w-2 h-2 rounded-full bg-[#F6BE3D] inline-block" />
                    </h3>
                    <p className="text-[11px] text-[#864D36] font-bold">Validator block builder telemetry</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 5: OFAC Hot-Set Cache */}
            <div
              onClick={() => setIsPolicyModalOpen(true)}
              className="tactile-card-sm bg-[#FAF5FF] rounded-2xl p-4 border-2 border-[#A87DD9] flex flex-col justify-between relative overflow-hidden min-h-[124px] cursor-pointer hover:scale-[1.01] transition-transform shadow-sm"
            >
              <div className="flex items-start justify-between">
                <span className="px-2 py-0.5 rounded-lg text-[10px] font-black uppercase bg-[#C084FC] text-white border border-[#7E22CE]">
                  IN-MEMORY
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-black bg-white border border-[#C084FC] px-2.5 py-0.5 rounded-lg text-[#581C87] shadow-sm">
                    {stats?.sanctions?.total_addresses ?? 121} addrs
                  </span>
                  <span className="text-[10px] font-black bg-[#9333EA] text-white px-1.5 py-0.5 rounded shadow-sm">
                    ACTIVE
                  </span>
                </div>
              </div>
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-[#C084FC] border border-[#7E22CE] flex items-center justify-center text-white text-base">
                    💾
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-[#581C87] flex items-center gap-1.5">
                      OFAC Hot-Set Cache <span className="w-2 h-2 rounded-full bg-[#A855F7] ping-slow inline-block" />
                    </h3>
                    <p className="text-[11px] text-[#7E22CE] font-bold">Real-time atomic Redis memory set</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Card 6: Exposed Blocks */}
            <div
              onClick={() => setActiveTab('blocks')}
              className="tactile-card-sm bg-[#FFF1F2] rounded-2xl p-4 border-2 border-[#D96B78] flex flex-col justify-between relative overflow-hidden min-h-[124px] cursor-pointer hover:scale-[1.01] transition-transform shadow-sm"
            >
              <div className="flex items-start justify-between">
                <span className="px-2 py-0.5 rounded-lg text-[10px] font-black uppercase bg-[#FB7185] text-white border border-[#BE123C]">
                  PROPOSER
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-black bg-white border border-[#FDA4AF] px-2.5 py-0.5 rounded-lg text-[#9F1239] shadow-sm">
                    {exposedBlocks} blocks
                  </span>
                  <span className="text-[10px] font-black bg-[#E11D48] text-white px-1.5 py-0.5 rounded shadow-sm">
                    ALERT
                  </span>
                </div>
              </div>
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-[#FB7185] border border-[#BE123C] flex items-center justify-center text-white text-base">
                    📋
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-[#9F1239] flex items-center gap-1.5">
                      Exposed Blocks <span className="w-2 h-2 rounded-full bg-[#E11D48] inline-block" />
                    </h3>
                    <p className="text-[11px] text-[#BE123C] font-bold">Validator proposer entity attribution</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Section 6: Real-Time Mempool Pipeline Table (Active Tab: Mempool) */}
        {activeTab === 'mempool' && (
          <section className="tactile-card bg-[#FFFDF9] rounded-3xl p-4 md:p-5 border-[3.5px] border-[#8F4C30] flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between pb-3 border-b-2 border-[#E7CDAF] gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-[#FFE4BA] border-2 border-[#8F4C30] flex items-center justify-center text-xl shadow-sm">
                  📦
                </div>
                <div>
                  <h3 className="text-base md:text-lg font-black text-[#692E19] uppercase">
                    Real-Time Mempool Pipeline
                  </h3>
                  <p className="text-xs font-bold text-[#A5684E]">
                    Showing {filteredDecisions.length} screened transactions. Click any row to inspect deterministic graph lineage.
                  </p>
                </div>
              </div>
              <div className="bg-[#F0DECB] border-2 border-[#AB6B50] rounded-xl px-2.5 py-1 text-xs font-mono font-bold text-[#723E2A] flex items-center gap-1.5 shadow-inner">
                <span className="w-2.5 h-2.5 rounded-full bg-[#48BB78] inline-block ping-slow" />
                <span>WS: Live Active</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm font-mono">
                <thead>
                  <tr className="border-b-2 border-[#EAD0B7] text-[11px] font-black uppercase text-[#8F4C30] tracking-wider">
                    <th className="py-2.5 px-3">TX HASH</th>
                    <th className="py-2.5 px-3">SENDER</th>
                    <th className="py-2.5 px-3">RECIPIENT</th>
                    <th className="py-2.5 px-3">ENTITY TYPE</th>
                    <th className="py-2.5 px-3">GRAPH HOP</th>
                    <th className="py-2.5 px-3">DECISION</th>
                    <th className="py-2.5 px-3">RISK SCORE</th>
                    <th className="py-2.5 px-3 text-right">AUDIT</th>
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-[#F4E2CD]">
                  {filteredDecisions.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="text-center py-10 font-bold text-[#A5684E] italic">
                        No transactions match your query or filter.
                      </td>
                    </tr>
                  ) : (
                    filteredDecisions.map((d) => (
                      <tr
                        key={d.tx_hash}
                        onClick={() => {
                          setSelected(d);
                          setActiveTab('lineage');
                        }}
                        className={`cursor-pointer hover:bg-[#FFF6EB] transition-colors ${
                          selected?.tx_hash === d.tx_hash ? 'bg-[#FFF2DE]' : ''
                        }`}
                      >
                        {/* Tx Hash */}
                        <td className="py-3 px-3 font-bold text-[#C8522A]">
                          <span className="flex items-center gap-1.5">
                            <span className="hover:underline">{shortAddr(d.tx_hash)} ↗</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCopy(d.tx_hash, d.tx_hash);
                              }}
                              title="Copy transaction hash"
                              className="p-0.5 text-[#8F4C30] hover:text-[#5C2B1A] transition-colors"
                            >
                              {copiedKey === d.tx_hash ? (
                                <Check className="size-3 text-[#2F855A]" />
                              ) : (
                                <Copy className="size-3 opacity-60 hover:opacity-100" />
                              )}
                            </button>
                          </span>
                        </td>

                        {/* Sender */}
                        <td className="py-3 px-3 text-[#692E19] font-medium">
                          {shortAddr(d.sender)}
                        </td>

                        {/* Recipient */}
                        <td className="py-3 px-3 text-[#692E19] font-medium">
                          {shortAddr(d.recipient)}
                        </td>

                        {/* Entity Type */}
                        <td className="py-3 px-3 font-sans">
                          {d.counterparty_entity_type ? (
                            <span className="px-2 py-0.5 rounded-lg border border-[#DDBFA4] bg-[#F7E7D1] text-[#4A1F0D] font-bold text-[10px]">
                              {d.counterparty_entity_type}
                            </span>
                          ) : (
                            <span className="text-[#A5684E]">—</span>
                          )}
                        </td>

                        {/* Graph Hop */}
                        <td className="py-3 px-3 font-sans">
                          {d.exposure_hop_distance === 1 && (
                            <span className="px-2 py-0.5 rounded-lg border border-[#DE9D2A] bg-[#FEF4D9] text-[#7B4E0E] font-black text-[10px]">
                              1-Hop
                            </span>
                          )}
                          {d.exposure_hop_distance === 2 && (
                            <span className="px-2 py-0.5 rounded-lg border border-[#DDA335] bg-[#FFF8E7] text-[#8C5D19] font-black text-[10px]">
                              2-Hop
                            </span>
                          )}
                          {!d.exposure_hop_distance && (
                            <span className="text-[#8F4C30] text-xs font-semibold">Direct Clean</span>
                          )}
                        </td>

                        {/* Decision */}
                        <td className="py-3 px-3 font-sans">
                          {d.decision === 'ALLOW' && (
                            <span className="btn-3d btn-3d-green px-3 py-1 rounded-xl text-xs font-black inline-flex items-center gap-1">
                              ✓ ALLOW
                            </span>
                          )}
                          {d.decision === 'FLAG' && (
                            <span className="btn-3d btn-3d-amber px-3 py-1 rounded-xl text-xs font-black inline-flex items-center gap-1">
                              ⚡ FLAG
                            </span>
                          )}
                          {d.decision === 'BLOCK' && (
                            <span className="btn-3d btn-3d-red px-3 py-1 rounded-xl text-xs font-black inline-flex items-center gap-1">
                              ✖ BLOCK
                            </span>
                          )}
                        </td>

                        {/* Risk Score */}
                        <td className="py-3 px-3 font-black">
                          <span
                            className={
                              d.risk_score >= 70
                                ? 'text-[#C53030]'
                                : d.risk_score >= 30
                                ? 'text-[#DD6B20]'
                                : 'text-[#2F855A]'
                            }
                          >
                            {d.risk_score} / 100
                          </span>
                        </td>

                        {/* Audit */}
                        <td className="py-3 px-3 text-right font-sans">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              window.open(`${API_URL}/api/decisions/${d.tx_hash}/report`, '_blank');
                            }}
                            className="btn-3d bg-[#FFF6EB] hover:bg-[#FFEBD6] text-[#542111] border-2 border-[#8F4C30] rounded-xl px-2.5 py-1 text-xs font-bold inline-flex items-center gap-1 shadow-sm cursor-pointer"
                          >
                            <FileText className="size-3 text-[#8F4C30]" />
                            <span>PDF</span>
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Tab 2: Block Builder Telemetry */}
        {activeTab === 'blocks' && (
          <section className="tactile-card bg-[#FFFDF9] rounded-3xl p-4 md:p-5 border-[3.5px] border-[#8F4C30] flex flex-col gap-4">
            <div className="flex items-center justify-between pb-3 border-b-2 border-[#E7CDAF]">
              <div>
                <h3 className="text-base md:text-lg font-black text-[#692E19] uppercase flex items-center gap-2">
                  <span>📦</span> Validator &amp; Proposer Block Registry
                </h3>
                <p className="text-xs font-bold text-[#A5684E]">
                  Audited blocks packaged by deterministic block engine.
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs sm:text-sm font-mono">
                <thead>
                  <tr className="border-b-2 border-[#EAD0B7] text-[11px] font-black uppercase text-[#8F4C30] tracking-wider">
                    <th className="py-2.5 px-3">Block Number</th>
                    <th className="py-2.5 px-3">Block Hash</th>
                    <th className="py-2.5 px-3">Builder / Proposer</th>
                    <th className="py-2.5 px-3">Tx Count</th>
                    <th className="py-2.5 px-3">Compliance Status</th>
                    <th className="py-2.5 px-3 text-right">Timestamp</th>
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-[#F4E2CD]">
                  {filteredBlocks.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="text-center py-10 font-bold text-[#A5684E] italic">
                        No built blocks recorded yet.
                      </td>
                    </tr>
                  ) : (
                    filteredBlocks.map((b) => (
                      <tr key={b.block_hash} className="hover:bg-[#FFF6EB] transition-colors">
                        <td className="py-3 px-3 font-black text-[#692E19]">
                          <button
                            onClick={() => setSearchQuery(b.block_number)}
                            title="Filter search to this block number"
                            className="hover:underline text-left cursor-pointer"
                          >
                            #{b.block_number}
                          </button>
                        </td>
                        <td className="py-3 px-3 text-[#A5684E]">
                          <span className="flex items-center gap-1.5">
                            <span>{shortAddr(b.block_hash)}</span>
                            <button
                              onClick={() => handleCopy(b.block_hash, b.block_hash)}
                              title="Copy block hash"
                              className="p-0.5 text-[#8F4C30] hover:text-[#5C2B1A] transition-colors cursor-pointer"
                            >
                              {copiedKey === b.block_hash ? (
                                <Check className="size-3 text-[#2F855A]" />
                              ) : (
                                <Copy className="size-3 opacity-60 hover:opacity-100" />
                              )}
                            </button>
                          </span>
                        </td>
                        <td className="py-3 px-3 text-[#692E19] font-bold">
                          <span className="flex items-center gap-1.5">
                            <span>{shortAddr(b.builder_address)}</span>
                            <button
                              onClick={() => handleCopy(b.builder_address, b.builder_address)}
                              title="Copy builder address"
                              className="p-0.5 text-[#8F4C30] hover:text-[#5C2B1A] transition-colors cursor-pointer"
                            >
                              {copiedKey === b.builder_address ? (
                                <Check className="size-3 text-[#2F855A]" />
                              ) : (
                                <Copy className="size-3 opacity-60 hover:opacity-100" />
                              )}
                            </button>
                          </span>
                        </td>
                        <td className="py-3 px-3 font-black text-[#266840]">
                          {b.tx_count} txs
                        </td>
                        <td className="py-3 px-3 font-sans">
                          {b.compliance_status === 'COMPLIANT_BUILD' ? (
                            <span className="px-2.5 py-1 rounded-xl bg-[#E5F7EB] border border-[#76D19B] text-[#245D3A] font-black text-xs">
                              COMPLIANT
                            </span>
                          ) : (
                            <span className="px-2.5 py-1 rounded-xl bg-[#FCE5E2] border border-[#F49A90] text-[#9B2C2C] font-black text-xs">
                              EXPOSED EXTERNAL
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-3 text-right text-[#8F4C30] font-sans text-xs">
                          {b.created_at ? new Date(b.created_at).toLocaleTimeString() : 'Recent'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Tab 3: Lineage & Audit Inspector */}
        {activeTab === 'lineage' && (
          <section className="tactile-card bg-[#FFFDF9] rounded-3xl p-4 md:p-6 border-[3.5px] border-[#8F4C30] space-y-5">
            {selected ? (
              <>
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b-2 border-[#E7CDAF]">
                  <div>
                    <span className="px-2.5 py-0.5 rounded-full bg-[#FFF2DE] border-2 border-[#8F4C30] text-[#8F4C30] text-[10px] font-black uppercase tracking-wider">
                      Audit Verification Proof
                    </span>
                    <h2 className="text-xl sm:text-2xl font-black text-[#692E19] mt-1">
                      Transaction Lineage &amp; Regulatory Audit
                    </h2>
                    <p className="text-xs font-bold text-[#A5684E]">
                      Evaluated under policy engine:{' '}
                      <span className="font-mono text-[#6A2E19] font-black bg-[#F6DFBE] px-2 py-0.5 rounded-lg border border-[#AC6F51]">
                        {selected.policy_version || 'STANDARD INSTITUTIONAL (STRICT 2-HOP)'}
                      </span>
                    </p>
                  </div>

                  <button
                    onClick={() => window.open(`${API_URL}/api/decisions/${selected.tx_hash}/report`, '_blank')}
                    className="btn-3d btn-3d-amber px-4 py-2.5 rounded-2xl text-white font-black text-xs sm:text-sm flex items-center justify-center gap-2 cursor-pointer shadow-sm"
                  >
                    <Download className="size-4" />
                    <span>Download Audit Report (PDF)</span>
                  </button>
                </div>

                {/* Identifiers & Outcome */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="tactile-card-sm bg-[#FFF8EE] p-4 rounded-2xl space-y-2 font-mono text-xs">
                    <p className="text-[10px] text-[#A06449] uppercase font-black tracking-wider">
                      Cryptographic Identifiers
                    </p>
                    <div>
                      <span className="text-[#A06449] block text-[10px]">TX HASH</span>
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="font-bold text-[#6A2E19] break-all">{selected.tx_hash}</span>
                        <button
                          onClick={() => handleCopy(selected.tx_hash, 'lineage_tx')}
                          title="Copy transaction hash"
                          className="p-1 text-[#8F4C30] hover:text-[#5C2B1A] transition-colors shrink-0 cursor-pointer"
                        >
                          {copiedKey === 'lineage_tx' ? (
                            <Check className="size-3.5 text-[#2F855A]" />
                          ) : (
                            <Copy className="size-3.5 opacity-60 hover:opacity-100" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div>
                      <span className="text-[#A06449] block text-[10px]">SENDER</span>
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="font-bold text-[#6A2E19] break-all">{selected.sender}</span>
                        <button
                          onClick={() => handleCopy(selected.sender, 'lineage_sender')}
                          title="Copy sender address"
                          className="p-1 text-[#8F4C30] hover:text-[#5C2B1A] transition-colors shrink-0 cursor-pointer"
                        >
                          {copiedKey === 'lineage_sender' ? (
                            <Check className="size-3.5 text-[#2F855A]" />
                          ) : (
                            <Copy className="size-3.5 opacity-60 hover:opacity-100" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div>
                      <span className="text-[#A06449] block text-[10px]">RECIPIENT</span>
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="font-bold text-[#6A2E19] break-all">{selected.recipient}</span>
                        <button
                          onClick={() => handleCopy(selected.recipient, 'lineage_recipient')}
                          title="Copy recipient address"
                          className="p-1 text-[#8F4C30] hover:text-[#5C2B1A] transition-colors shrink-0 cursor-pointer"
                        >
                          {copiedKey === 'lineage_recipient' ? (
                            <Check className="size-3.5 text-[#2F855A]" />
                          ) : (
                            <Copy className="size-3.5 opacity-60 hover:opacity-100" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="tactile-card-sm bg-[#FFF8EE] p-4 rounded-2xl space-y-2.5 text-xs">
                    <p className="text-[10px] text-[#A06449] uppercase font-black tracking-wider">
                      Evaluation &amp; Entity Graph
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[#8F4C30]">Entity Type:</span>
                      <span className="font-mono font-black px-2.5 py-0.5 rounded-lg border border-[#8F4C30] bg-white">
                        {selected.counterparty_entity_type || 'Unknown EOA'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[#8F4C30]">Graph Distance:</span>
                      <span className="font-mono font-black px-2.5 py-0.5 rounded-lg border border-[#8F4C30] bg-white">
                        {selected.exposure_hop_distance ? `${selected.exposure_hop_distance}-Hop Link` : 'Clean Direct'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-[#8F4C30]">Decision Verdict:</span>
                      <span
                        className={`px-3 py-1 rounded-xl text-xs font-black text-white ${
                          selected.decision === 'ALLOW'
                            ? 'bg-[#48BB78]'
                            : selected.decision === 'FLAG'
                            ? 'bg-[#ED8936]'
                            : 'bg-[#E53E3E]'
                        }`}
                      >
                        {selected.decision}
                      </span>
                    </div>
                    <div className="flex items-center justify-between pt-1 border-t border-[#EAD0B7]">
                      <span className="font-bold text-[#8F4C30]">Calculated Risk:</span>
                      <span className="font-mono font-black text-sm text-[#6A2E19]">
                        {selected.risk_score} / 100
                      </span>
                    </div>
                  </div>
                </div>

                {/* Visual Traversal Diagram */}
                <div className="tactile-card-sm bg-[#FFFBF0] p-4 rounded-2xl">
                  <p className="text-[10px] text-[#A06449] uppercase font-black tracking-wider mb-2">
                    Multi-Hop Lineage Traversal Graph
                  </p>
                  <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto py-2 font-mono text-xs">
                    <div className="px-3 py-2 rounded-xl bg-white border-2 border-[#8F4C30] text-center shrink-0 shadow-sm">
                      <span className="text-[9px] text-[#A06449] font-bold block">SENDER</span>
                      <span className="font-bold text-[#6A2E19]">{shortAddr(selected.sender)}</span>
                    </div>
                    <ArrowRight className="size-4 text-[#8F4C30] shrink-0" />
                    <div className="px-3 py-2 rounded-xl bg-white border-2 border-[#8F4C30] text-center shrink-0 shadow-sm">
                      <span className="text-[9px] text-[#A06449] font-bold block">RECIPIENT</span>
                      <span className="font-bold text-[#6A2E19]">{shortAddr(selected.recipient)}</span>
                    </div>
                    <ArrowRight className="size-4 text-[#8F4C30] shrink-0" />
                    <div
                      className={`px-3 py-2 rounded-xl border-2 border-[#8F4C30] text-center shrink-0 shadow-sm ${
                        selected.exposure_hop_distance
                          ? 'bg-[#FEF4DB] text-[#8C5D17]'
                          : 'bg-[#EAF7ED] text-[#266840]'
                      }`}
                    >
                      <span className="text-[9px] font-black block">LINEAGE STATUS</span>
                      <span className="font-black">
                        {selected.exposure_hop_distance
                          ? `${selected.exposure_hop_distance}-Hop Counterparty Link`
                          : 'Sanction-Free Clean'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* AI Explanation Memo */}
                {selected.ai_explanation && (
                  <div className="tactile-card-sm bg-[#FFF8EE] p-4 rounded-2xl space-y-1">
                    <div className="flex items-center gap-1.5 text-xs font-black text-[#692E19] uppercase tracking-wide">
                      <Sparkles className="size-4 text-[#F6BE3D]" />
                      <span>AI Regulatory Compliance Narrative</span>
                    </div>
                    <p className="text-xs md:text-sm text-[#743C28] font-semibold leading-relaxed">
                      {selected.ai_explanation}
                    </p>
                  </div>
                )}
              </>
            ) : (
              <div className="text-center py-10 font-bold text-[#A5684E]">
                Select any transaction from the Mempool Pipeline to view audit proofs.
              </div>
            )}
          </section>
        )}

        {/* Tab 4: Relay Auction (Active Tab: Auction) */}
        {activeTab === 'auction' && (
          <section className="tactile-card bg-[#FFFDF9] rounded-3xl p-5 md:p-6 space-y-6">
            {/* Header / Sub-nav */}
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b-2 border-[#E7D6C5]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-[#E5F7EB] border-2 border-[#48BB78] flex items-center justify-center text-xl shadow-sm">
                  🏆
                </div>
                <div>
                  <h2 className="text-xl md:text-2xl font-black text-[#5C2B1A] flex items-center gap-2">
                    Relay Compliance Auction
                    <span className="text-xs px-2.5 py-0.5 rounded-full bg-[#E5F7EB] border border-[#48BB78] text-[#1D5E38] font-bold">
                      LIVE GATE
                    </span>
                  </h2>
                  <p className="text-xs text-[#8A4C33] font-semibold">
                    Real-time builder bids screened through deterministic policy engine before winning header selection
                  </p>
                </div>
              </div>

              {/* Slot & Actions */}
              <div className="flex items-center flex-wrap gap-2.5">
                <div className="flex items-center bg-[#F5E4D0] border-2 border-[#8F4C30] rounded-2xl px-3 py-1.5 gap-2">
                  <span className="text-xs font-bold text-[#7F442C]">Slot:</span>
                  <input
                    type="number"
                    value={selectedSlot}
                    onChange={(e) => setSelectedSlot(Number(e.target.value) || 0)}
                    className="w-16 bg-white border border-[#8F4C30] rounded-lg px-2 py-0.5 text-xs font-mono font-bold text-[#5C2B1A] focus:outline-none"
                  />
                  <button
                    onClick={() => reRunSlotAudit(selectedSlot)}
                    disabled={isReevaluatingSlot}
                    className="p-1 rounded-lg bg-[#ECD0B3] hover:bg-[#E3C3A0] text-[#692E19] transition-all"
                    title="Refresh Slot Verdicts"
                  >
                    <RefreshCw className={`size-3.5 ${isReevaluatingSlot ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                <button
                  onClick={() => setIsPolicyModalOpen(true)}
                  className="px-3.5 py-2 rounded-2xl font-black text-xs bg-[#FFF8EE] border-2 border-[#8F4C30] text-[#692E19] hover:bg-[#FFF0DF] transition-all flex items-center gap-1.5 shadow-sm"
                >
                  <SlidersHorizontal className="size-3.5" />
                  <span>Switch Policy</span>
                </button>

                <button
                  onClick={() => downloadSarPack(selectedSlot)}
                  className="btn-3d bg-[#48BB78] border-2 border-[#1D5E38] text-white px-3.5 py-2 rounded-2xl font-black text-xs flex items-center gap-1.5 shadow-md hover:brightness-105 transition-all"
                >
                  <Download className="size-3.5" />
                  <span>Export Signed SAR Pack (.zip)</span>
                </button>
              </div>
            </div>

            {/* Winning Header Spotlight Card */}
            {bestHeader ? (
              <div className="tactile-card bg-[#E5F7EB] border-[3px] border-[#48BB78] rounded-2xl p-4 md:p-5 flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                  <div className="w-12 h-12 rounded-2xl bg-[#48BB78] text-white flex items-center justify-center text-2xl shadow-sm">
                    🥇
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-black uppercase tracking-wider text-[#1D5E38]">
                        WINNING COMPLIANT BLOCK HEADER
                      </span>
                      <span className="px-2 py-0.5 rounded-md bg-white border border-[#48BB78] text-[#1D5E38] font-mono text-xs font-black">
                        Slot {bestHeader.slot}
                      </span>
                    </div>
                    <div className="text-lg md:text-xl font-black text-[#154629] font-mono mt-0.5">
                      {bestHeader.builder_id}
                    </div>
                    <div className="text-xs text-[#286C45] font-mono">
                      Block: {bestHeader.block_hash.slice(0, 18)}... | Recipient: {shortAddr(bestHeader.fee_recipient)}
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-xs uppercase font-bold text-[#1D5E38]">Validated MEV Bid Value</div>
                  <div className="text-2xl md:text-3xl font-black font-mono text-[#154629]">
                    {(Number(bestHeader.value_wei) / 1e18).toFixed(4)} ETH
                  </div>
                  <div className="text-[11px] text-[#286C45] font-bold">
                    ✓ Cryptographically Proven Sanction-Free
                  </div>
                </div>
              </div>
            ) : (
              <div className="tactile-card bg-[#FFF8EE] border-2 border-[#8F4C30] rounded-2xl p-4 text-center">
                <p className="text-sm font-bold text-[#8A4C33]">
                  No compliant header selected for Slot {selectedSlot}. All submitted bids either pending or disqualified.
                </p>
              </div>
            )}

            {/* Auction Bids Table */}
            <div className="border-2 border-[#8F4C30] rounded-2xl overflow-hidden bg-white shadow-inner">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm font-mono">
                  <thead className="bg-[#F8ECE0] text-[#7A3F29] uppercase font-black text-[11px] tracking-wider border-b-2 border-[#8F4C30]">
                    <tr>
                      <th className="py-3 px-4">Builder ID</th>
                      <th className="py-3 px-4">Bid Value</th>
                      <th className="py-3 px-4">Compliance Verdict</th>
                      <th className="py-3 px-4">Reason Codes &amp; Disqualification Proof</th>
                      <th className="py-3 px-4">AI Audit Narration</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#F1DEC9]">
                    {relayBids.length > 0 ? (
                      relayBids.map((bid) => {
                        const isWinner = bestHeader?.builder_id === bid.builder_id && bid.verdict === 'COMPLIANT';
                        const isTainted = bid.verdict === 'EXPOSED_TX' || bid.verdict === 'EXPOSED_BUILDER';
                        const valueEth = (Number(bid.value_wei) / 1e18).toFixed(4);

                        return (
                          <tr
                            key={bid.id}
                            className={`transition-colors ${
                              isWinner
                                ? 'bg-[#E5F7EB]/70 font-semibold'
                                : isTainted
                                ? 'bg-red-50/60'
                                : 'hover:bg-[#FFF9F2]'
                            }`}
                          >
                            {/* Builder */}
                            <td className="py-3.5 px-4 font-bold align-top">
                              <div className="flex items-center gap-2">
                                {isWinner && <span className="text-sm">🏆</span>}
                                {isTainted && <span className="text-sm">⛔</span>}
                                <span
                                  className={`${
                                    isWinner
                                      ? 'text-[#1D5E38] font-black'
                                      : isTainted
                                      ? 'line-through text-red-600 font-semibold'
                                      : 'text-[#5C2B1A]'
                                  }`}
                                >
                                  {bid.builder_id}
                                </span>
                                <button
                                  onClick={() => handleCopy(bid.builder_id, `bid_${bid.id}_builder`)}
                                  title="Copy builder ID"
                                  className="p-0.5 text-[#8F4C30] hover:text-[#5C2B1A] transition-colors cursor-pointer"
                                >
                                  {copiedKey === `bid_${bid.id}_builder` ? (
                                    <Check className="size-3 text-[#2F855A]" />
                                  ) : (
                                    <Copy className="size-3 opacity-60 hover:opacity-100" />
                                  )}
                                </button>
                              </div>
                              <div className="text-[10px] text-[#A06449] font-normal font-mono flex items-center gap-1 mt-0.5">
                                <span>Fee: {shortAddr(bid.fee_recipient)}</span>
                                <button
                                  onClick={() => handleCopy(bid.fee_recipient, `bid_${bid.id}_fee`)}
                                  title="Copy fee recipient address"
                                  className="p-0.5 text-[#8F4C30] hover:text-[#5C2B1A] transition-colors cursor-pointer"
                                >
                                  {copiedKey === `bid_${bid.id}_fee` ? (
                                    <Check className="size-2.5 text-[#2F855A]" />
                                  ) : (
                                    <Copy className="size-2.5 opacity-60 hover:opacity-100" />
                                  )}
                                </button>
                              </div>
                            </td>

                            {/* Value */}
                            <td className="py-3.5 px-4 font-black align-top">
                              <span
                                className={`text-sm ${
                                  isWinner
                                    ? 'text-[#1D5E38]'
                                    : isTainted
                                    ? 'line-through text-red-600'
                                    : 'text-[#5C2B1A]'
                                }`}
                              >
                                {valueEth} ETH
                              </span>
                            </td>

                            {/* Verdict */}
                            <td className="py-3.5 px-4 align-top">
                              {isWinner ? (
                                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-[#E5F7EB] border-2 border-[#48BB78] text-[#1D5E38] text-xs font-black">
                                  ✓ COMPLIANT (WINNER)
                                </span>
                              ) : bid.verdict === 'COMPLIANT' ? (
                                <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-[#E5F7EB] border border-[#48BB78] text-[#1D5E38] text-xs font-bold">
                                  COMPLIANT
                                </span>
                              ) : bid.verdict === 'EXPOSED_TX' ? (
                                <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-red-100 border-2 border-red-500 text-red-700 text-xs font-black">
                                  ⛔ EXPOSED TX (DISQUALIFIED)
                                </span>
                              ) : bid.verdict === 'EXPOSED_BUILDER' ? (
                                <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-red-100 border-2 border-red-500 text-red-700 text-xs font-black">
                                  ⛔ EXPOSED BUILDER (DISQUALIFIED)
                                </span>
                              ) : (
                                <span className="inline-flex items-center px-2.5 py-1 rounded-full bg-amber-100 border border-amber-400 text-amber-800 text-xs font-bold">
                                  PENDING AUDIT
                                </span>
                              )}
                            </td>

                            {/* Reasons */}
                            <td className="py-3.5 px-4 max-w-xs break-words align-top">
                              {bid.reasons && bid.reasons.length > 0 ? (
                                <div className="space-y-1.5">
                                  {bid.reasons.length > 1 && (
                                    <div className="text-[10px] font-extrabold uppercase tracking-wide text-red-700 flex items-center gap-1">
                                      <span>⚠️ {bid.reasons.length} Violations / Flags</span>
                                    </div>
                                  )}
                                  <div className="max-h-28 overflow-y-auto space-y-1 pr-1">
                                    {bid.reasons.map((r, idx) => (
                                      <div
                                        key={idx}
                                        title={r}
                                        className="px-2 py-1 text-[10px] rounded bg-red-100 border border-red-300 text-red-800 font-semibold break-words [overflow-wrap:anywhere]"
                                      >
                                        {formatReason(r)}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                <span className="text-[11px] text-[#48BB78] font-bold">
                                  Zero sanctions exposure detected
                                </span>
                              )}
                            </td>

                            {/* AI Summary */}
                            <td className="py-3.5 px-4 max-w-sm break-words align-top">
                              {bid.ai_summary ? (
                                <div
                                  title={bid.ai_summary}
                                  className="text-[11px] text-[#5C2B1A] font-sans font-semibold leading-snug bg-[#FFF8EE] border border-[#ECD0B3] p-2 rounded-xl break-words [overflow-wrap:anywhere]"
                                >
                                  <div className="flex items-center gap-1 text-[10px] font-extrabold text-[#964724] uppercase mb-0.5">
                                    <Sparkles className="size-3 text-amber-500 shrink-0" />
                                    <span>Audit Note</span>
                                  </div>
                                  {formatReason(bid.ai_summary)}
                                </div>
                              ) : (
                                <span className="text-[11px] text-[#B58570] italic">
                                  Narration pending...
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={5} className="py-8 text-center text-[#8A4C33] font-bold">
                          No bids recorded for Slot {selectedSlot}. Run mock builders (`cargo run --bin mock_builders -- --slot {selectedSlot}`) to populate live auction.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        {/* Section 7: Bottom HUD Status Dock (Exact Match to Reference Screen) */}
        <footer className="tactile-card bg-[#F5E4D0] rounded-3xl p-3.5 px-6 flex flex-wrap items-center justify-between gap-4 border-[3.5px] border-[#8F4C30]">
          {/* Telemetry */}
          <div className="flex items-center flex-wrap gap-4 text-xs font-bold text-[#7F442C]">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[#48BB78]" />
              <span>Engine: <strong className="text-[#592614] font-extrabold">Rust Deterministic SVM</strong></span>
            </div>
            <span className="text-[#C69C84]">•</span>
            <div>
              Gate Latency:{' '}
              <span className="font-mono font-extrabold text-[#235C37] bg-[#E8F8ED] px-2 py-0.5 rounded-lg border border-[#85DAA4]">
                2.33µs
              </span>
            </div>
            <span className="text-[#C69C84]">•</span>
            <div>OFAC Hot-Set: <strong className="font-mono text-[#592614]">121 Addrs Atomic Sync</strong></div>
          </div>

          {/* Shortcuts */}
          <div className="flex items-center flex-wrap gap-2 text-xs font-bold text-[#7F442C]">
            <span className="text-xs uppercase tracking-wider text-[#A0644B]">TACTILE SHORTCUTS:</span>
            <button
              onClick={() => setIsPaused((prev) => !prev)}
              className={`px-2.5 py-1 rounded-xl border-2 font-mono text-xs shadow-sm font-bold cursor-pointer hover:scale-[1.03] active:scale-95 transition-all flex items-center gap-1.5 ${
                isPaused
                  ? 'bg-[#FED7D7] text-[#9B2C2C] border-[#E53E3E]'
                  : 'bg-[#FFF6EB] hover:bg-[#FFEBD6] border-[#8F4C30] text-[#542111]'
              }`}
              title="Press Space or click to toggle live auto-polling"
            >
              <span>{isPaused ? '⏸️ [Space] Paused' : '▶️ [Space] Live (Click to Pause)'}</span>
            </button>
            <button
              onClick={() => {
                searchInputRef.current?.focus();
                searchInputRef.current?.select();
              }}
              className="px-2.5 py-1 rounded-xl bg-[#FFF6EB] hover:bg-[#FFEBD6] border-2 border-[#8F4C30] font-mono text-[#542111] shadow-sm font-bold cursor-pointer hover:scale-[1.03] active:scale-95 transition-all"
              title="Press / or click to search"
            >
              [/] Search
            </button>
            <button
              onClick={() => void fetchAll()}
              className="px-2.5 py-1 rounded-xl bg-[#FFF6EB] hover:bg-[#FFEBD6] border-2 border-[#8F4C30] font-mono text-[#542111] shadow-sm font-bold cursor-pointer hover:scale-[1.03] active:scale-95 transition-all flex items-center gap-1"
              title="Press R or click to refresh immediately"
            >
              <RefreshCw className="size-3 text-[#8F4C30]" />
              <span>[R] Refresh</span>
            </button>
          </div>
        </footer>

        {/* EDD Review Inbox Drawer */}
        {isEddDrawerOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-end bg-black/50 backdrop-blur-sm p-4">
            <div className="tactile-card bg-[#FFFDF9] rounded-3xl p-6 w-full max-w-xl max-h-[90vh] overflow-y-auto space-y-4 border-[3px] border-[#8F4C30] shadow-2xl">
              <div className="flex items-center justify-between pb-3 border-b-2 border-[#E7D6C5]">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-orange-100 border border-orange-400 flex items-center justify-center text-lg">
                    🛡️
                  </div>
                  <div>
                    <h3 className="text-lg font-black text-[#5C2B1A]">Enhanced Due Diligence (EDD) Queue</h3>
                    <p className="text-xs text-[#8A4C33]">Automated FLAG review &amp; compliance auditor sign-off</p>
                  </div>
                </div>
                <button
                  onClick={() => setIsEddDrawerOpen(false)}
                  className="p-1.5 rounded-xl bg-[#F0DECB] hover:bg-[#E3C3A0] text-[#692E19]"
                >
                  <X className="size-5" />
                </button>
              </div>

              {/* Note input */}
              <div className="space-y-1">
                <label className="text-xs font-bold text-[#692E19]">Auditor Resolution Note:</label>
                <input
                  type="text"
                  value={eddNote}
                  onChange={(e) => setEddNote(e.target.value)}
                  placeholder="e.g. Originator VASP KYC certificate verified offline"
                  className="w-full bg-[#FFF8EE] border-2 border-[#8F4C30] rounded-xl px-3 py-2 text-xs text-[#5C2B1A] font-medium focus:outline-none"
                />
              </div>

              {/* Cases List */}
              <div className="space-y-3">
                {eddCases.length > 0 ? (
                  eddCases.map((c) => (
                    <div
                      key={c.id}
                      className="tactile-card-sm bg-[#FFF8EE] p-3.5 rounded-2xl space-y-2 border border-[#ECD0B3]"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs font-black text-[#5C2B1A]">Case #{c.id}</span>
                        <span
                          className={`px-2 py-0.5 rounded-full text-[10px] font-black ${
                            c.status === 'OPEN'
                              ? 'bg-amber-100 border border-amber-400 text-amber-800 animate-pulse'
                              : c.status === 'APPROVED'
                              ? 'bg-emerald-100 border border-emerald-400 text-emerald-800'
                              : 'bg-red-100 border border-red-400 text-red-800'
                          }`}
                        >
                          {c.status}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-[#8F4C30] break-all">
                        Tx: {c.tx_hash}
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-bold text-[#7A3F29]">Risk Score:</span>
                        <span className="font-mono font-extrabold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">
                          {c.risk_score} / 100
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {c.reasons &&
                          c.reasons.map((r, i) => (
                            <span
                              key={i}
                              title={r}
                              className="px-1.5 py-0.5 bg-red-50 border border-red-200 text-red-700 text-[10px] font-bold rounded break-words [overflow-wrap:anywhere]"
                            >
                              {formatReason(r)}
                            </span>
                          ))}
                      </div>
                      {c.note && (
                        <div className="text-[11px] text-[#692E19] italic bg-white p-2 rounded-lg border border-[#E7D6C5]">
                          Note: {c.note}
                        </div>
                      )}

                      {c.status === 'OPEN' && (
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            onClick={() => resolveEddCase(c.id, 'APPROVED')}
                            disabled={isResolvingEdd === c.id}
                            className="btn-3d bg-[#48BB78] border border-[#1D5E38] text-white px-3 py-1.5 rounded-xl font-bold text-xs hover:brightness-105"
                          >
                            ✓ Approve (Whitelist)
                          </button>
                          <button
                            onClick={() => resolveEddCase(c.id, 'QUARANTINED')}
                            disabled={isResolvingEdd === c.id}
                            className="btn-3d bg-[#E53E3E] border border-[#9B2C2C] text-white px-3 py-1.5 rounded-xl font-bold text-xs hover:brightness-105"
                          >
                            ✕ Quarantine
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="text-center py-6 text-xs text-[#8A4C33] font-bold">
                    No EDD cases in queue.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

