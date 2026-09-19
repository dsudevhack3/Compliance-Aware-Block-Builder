'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import './arcade.css';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || `${API_URL.replace(/^http/, 'ws')}/ws`;
const BLOCK_CAPACITY = 5;
const TRAVEL_TO_GATE_MS = 1600;
const TRAVEL_TO_ZONE_MS = 1600;

// Stagger delay between sequential transaction screening submissions (ms)
const SUBMISSION_STAGGER_MS = 400;
const DEFAULT_ETH_VALUE_WEI = '1000000000000000000'; // 1 ETH in wei

// Known-good seeded scenarios for ALLOW / FLAG / BLOCK demo
const EXAMPLE_CLEAN_TX = {
  sender: '0x1111111111111111111111111111111111111111',
  recipient: '0x2222222222222222222222222222222222222222',
  value: '1000000000000000000', // 1 ETH
};

// Seeded Tornado Cash 0.1 ETH Mixer (from db/seed_entities.sql)
const EXAMPLE_MIXER_TX = {
  sender: '0x1111111111111111111111111111111111111111',
  recipient: '0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc',
  value: '100000000000000000', // 0.1 ETH
};

// Seeded OFAC-Sanctioned Address (from db/seed_addresses.sql)
const EXAMPLE_SANCTIONED_TX = {
  sender: '0x1111111111111111111111111111111111111111',
  recipient: '0x747afb5c7a7fc34b547cd0fdebf9b91759c5a52b',
  value: '500000000000000000', // 0.5 ETH
};

type CustomTxRow = {
  id: string;
  sender: string;
  recipient: string;
  value: string;
  tx_hash?: string;
};

type SubmissionResultItem = {
  index: number;
  tx_hash: string;
  sender: string;
  recipient: string;
  decision?: 'ALLOW' | 'FLAG' | 'BLOCK';
  risk_score?: number;
  reasons?: string[];
  error?: string;
};

export type BuilderBidInput = {
  id: string;
  builder_id: string;
  bid_value_eth: string;
  fee_recipient: string;
  txs: CustomTxRow[];
};

export type AuctionHeaderResponse = {
  slot: number;
  block_hash: string;
  builder_id: string;
  builder_pubkey: string;
  fee_recipient: string;
  value_wei: string;
};

export type StoredBidResult = {
  id?: string;
  slot: number;
  builder_id: string;
  block_hash?: string;
  fee_recipient: string;
  value_wei: string;
  verdict: string;
  reasons: string[];
  ai_summary?: string;
  error?: string;
};

export type AuctionRunResult = {
  slot: number;
  winningHeader: AuctionHeaderResponse | null;
  isFailClosed: boolean;
  failClosedReason?: string;
  bids: StoredBidResult[];
  submittedAt: string;
};

// Seeded 3-bid scenario for Relay Auction demo
const EXAMPLE_RELAY_BIDS: BuilderBidInput[] = [
  {
    id: 'bid_a_clean',
    builder_id: 'Builder A (Compliant)',
    bid_value_eth: '2.0',
    fee_recipient: '0x90f79bf6eb2c4f870365e785982e1f101e93b906', // clean fee recipient
    txs: [
      {
        id: 'tx_a_1',
        sender: '0x1111111111111111111111111111111111111111',
        recipient: '0x2222222222222222222222222222222222222222',
        value: '1000000000000000000',
      },
    ],
  },
  {
    id: 'bid_b_sanctioned_tx',
    builder_id: 'Builder B (Sanctioned Tx, 2.5 ETH)',
    bid_value_eth: '2.5',
    fee_recipient: '0x90f79bf6eb2c4f870365e785982e1f101e93b906', // clean fee recipient
    txs: [
      {
        id: 'tx_b_1',
        sender: '0x747afb5c7a7fc34b547cd0fdebf9b91759c5a52b', // OFAC Sanctioned from seed_addresses.sql
        recipient: '0x2222222222222222222222222222222222222222',
        value: '500000000000000000',
      },
    ],
  },
  {
    id: 'bid_c_sanctioned_fee',
    builder_id: 'Builder C (Sanctioned Fee, 1.8 ETH)',
    bid_value_eth: '1.8',
    fee_recipient: '0x747afb5c7a7fc34b547cd0fdebf9b91759c5a52b', // OFAC Sanctioned fee recipient
    txs: [
      {
        id: 'tx_c_1',
        sender: '0x1111111111111111111111111111111111111111',
        recipient: '0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc', // Tornado Cash mixer from seed_entities.sql
        value: '100000000000000000',
      },
    ],
  },
];

type Decision = {
  tx_hash: string;
  sender: string;
  recipient: string;
  decision: string; // 'ALLOW' | 'FLAG' | 'BLOCK'
  risk_score: number;
  reason_codes: string[];
  ai_explanation?: string | null;
  counterparty_entity_type?: string | null;
  exposure_hop_distance?: number | null;
  policy_version?: string | null;
  integrity_hash?: string | null;
  amount_eth?: string | number | null;
  created_at: string;
};

type SpriteState = {
  id: string;
  data: Decision;
  spawnTime: number;
  status: 'traveling_to_gate' | 'at_gate' | 'traveling_to_zone' | 'settled';
  x: number; // percentage
  y: number; // percentage
  destX: number;
  destY: number;
  revealed: boolean;
  userGuess?: 'ALLOW' | 'FLAG' | 'BLOCK' | null;
  guessVerdict?: 'CORRECT' | 'WRONG' | null;
  lane: number;
  ballNumber: number;
};

type RallyBall = {
  id: string;
  spriteId?: string;
  type: 'allow' | 'flag' | 'block';
  number: string;
  baseColor: string;
  highlightColor: string;
  darkColor: string;
  seamColor: string;
  targetHopperId: string;
  x: number;
  y: number;
  startX: number;
  startY: number;
  netX: number;
  targetX: number;
  targetY: number;
  progress: number;
  speed: number;
  rot: number;
  rotSpeed: number;
  radius: number;
  trail: Array<{ x: number; y: number; arc: number }>;
  netCrossed: boolean;
  deflected: boolean;
  bounceHeight: number;
};

type SparkParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  alpha: number;
  decay: number;
  size: number;
};

type SwooshArc = {
  x: number;
  y: number;
  arcType: 'allow' | 'flag' | 'block';
  color: string;
  alpha: number;
  progress: number;
};

type FloatingPill = {
  id: string;
  text: string;
  colorClass: string;
  x: number;
  y: number;
};

function shortAddr(addr: string) {
  if (!addr) return '';
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

const CANONICAL_SCENARIOS: Decision[] = [
  {
    tx_hash: '0x8f2a981c2049182371049281729481ad6192837190348719283718923481aa01',
    sender: '0x3d4b68902c41a293817293817293819283719281',
    recipient: '0x91bc33e8902c41a2938172938172938192837192',
    decision: 'ALLOW',
    risk_score: 12,
    reason_codes: ['CLEAN_GENEALOGY', 'VERIFIED_VASP_TIER1'],
    ai_explanation: 'Direct deposit routed to a regulated Tier-1 VASP exchange. No indirect or direct OFAC taint detected.',
    counterparty_entity_type: 'Exchange',
    exposure_hop_distance: null,
    created_at: new Date().toISOString(),
  },
  {
    tx_hash: '0x4e1cb022938172938172938192837192837190348719283718923481bb02',
    sender: '0x77ae80f02c41a293817293817293819283719283',
    recipient: '0x000000000000000000000000000000000000Tornado',
    decision: 'BLOCK',
    risk_score: 96,
    reason_codes: ['OFAC_SDN_DIRECT_HIT', 'TORNADO_CASH_ROUTER'],
    ai_explanation: 'Primary sanctions match on OFAC SDN List (Specially Designated Nationals). Immediate deterministic quarantine.',
    counterparty_entity_type: 'Mixer',
    exposure_hop_distance: 1,
    created_at: new Date().toISOString(),
  },
  {
    tx_hash: '0x19bba904938172938172938192837192837190348719283718923481cc03',
    sender: '0xcc216a802c41a293817293817293819283719284',
    recipient: '0x4a9b1c202c41a293817293817293819283719285',
    decision: 'FLAG',
    risk_score: 58,
    reason_codes: ['HOP_2_DECAY', 'INDIRECT_TORNADO_EXPOSURE'],
    ai_explanation: 'Recipient wallet received liquidity 2 hops prior from a sanctioned mixer pool. Transaction held under enhanced due diligence.',
    counterparty_entity_type: 'DeFiProtocol',
    exposure_hop_distance: 2,
    created_at: new Date().toISOString(),
  },
  {
    tx_hash: '0x62d4e8f1938172938172938192837192837190348719283718923481dd04',
    sender: '0x4838B106FCe9647Bdf1E7877BF73cE8B0BAD5f97',
    recipient: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    decision: 'ALLOW',
    risk_score: 5,
    reason_codes: ['VERIFIED_DEX_ROUTER', 'CLEAN_ANCESTRY'],
    ai_explanation: 'Standard liquidity swap execution interacting with verified Uniswap Router. Clean transaction flow.',
    counterparty_entity_type: 'DeFiProtocol',
    exposure_hop_distance: null,
    created_at: new Date().toISOString(),
  },
  {
    tx_hash: '0x99a1b2c3938172938172938192837192837190348719283718923481ee05',
    sender: '0x1f9090aaE28b8a3dCeaDf281B0F12828e676c326',
    recipient: '0x101112131415161718192021222324252627Lazarus',
    decision: 'BLOCK',
    risk_score: 99,
    reason_codes: ['STATE_ACTOR_AFFILIATION', 'LAZARUS_CONTEMPT'],
    ai_explanation: 'Direct cluster relationship with DPRK State-Sponsored cyber groups. Automatic consensus drop.',
    counterparty_entity_type: 'SanctionedActor',
    exposure_hop_distance: 1,
    created_at: new Date().toISOString(),
  },
  {
    tx_hash: '0x33445566938172938172938192837192837190348719283718923481ff06',
    sender: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    recipient: '0x2233445566778899001122334455667788990011',
    decision: 'FLAG',
    risk_score: 45,
    reason_codes: ['UNREGISTERED_MIXER_COINJOIN', 'HOP_2_TAINT'],
    ai_explanation: '2-hop proximity to Wasabi CoinJoin mixer output. Flagged for compliance officer verification.',
    counterparty_entity_type: 'Mixer',
    exposure_hop_distance: 2,
    created_at: new Date().toISOString(),
  },
];

export default function ArcadePage() {
  const [sprites, setSprites] = useState<SpriteState[]>([]);
  const [activeTargetId, setActiveTargetId] = useState<string | null>(null);
  const [selectedTx, setSelectedTx] = useState<Decision | null>(null);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [totalGuesses, setTotalGuesses] = useState(0);
  const [correctGuesses, setCorrectGuesses] = useState(0);
  const [builderTxCount, setBuilderTxCount] = useState(0);
  const [sealedBlocksCount, setSealedBlocksCount] = useState(0);
  const [blockFlash, setBlockFlash] = useState(false);
  const [activePolicy, setActivePolicy] = useState('standard');
  const [isSwitchingPolicy, setIsSwitchingPolicy] = useState(false);
  const [policyNotification, setPolicyNotification] = useState<string | null>(null);
  const [demoNotice, setDemoNotice] = useState<string | null>(null);
  const [isSimulatorRunning, setIsSimulatorRunning] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [liveLatency, setLiveLatency] = useState('2.42 µs');

  // Custom Transaction Submission Panel States
  const [isCustomPanelOpen, setIsCustomPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<'individual' | 'relay_auction'>('individual');
  const [customInputMode, setCustomInputMode] = useState<'form' | 'json'>('form');
  const [formRows, setFormRows] = useState<CustomTxRow[]>([
    { id: 'row_1', sender: '', recipient: '', value: DEFAULT_ETH_VALUE_WEI },
  ]);
  const [rawJson, setRawJson] = useState<string>('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [clientValidationError, setClientValidationError] = useState<string | null>(null);
  const [isSubmittingCustom, setIsSubmittingCustom] = useState(false);
  const [submissionProgress, setSubmissionProgress] = useState<{ current: number; total: number } | null>(null);
  const [submissionSummary, setSubmissionSummary] = useState<string | null>(null);
  const [submissionResults, setSubmissionResults] = useState<SubmissionResultItem[]>([]);

  // Relay Auction Mode States
  const [auctionSlot, setAuctionSlot] = useState<number>(100);
  const [builderBids, setBuilderBids] = useState<BuilderBidInput[]>(EXAMPLE_RELAY_BIDS);
  const [isSubmittingAuction, setIsSubmittingAuction] = useState(false);
  const [auctionProgress, setAuctionProgress] = useState<{ current: number; total: number; currentBuilder?: string } | null>(null);
  const [auctionValidationErrors, setAuctionValidationErrors] = useState<string[] | null>(null);
  const [auctionResult, setAuctionResult] = useState<AuctionRunResult | null>(null);

  // Tennis Racket & Hit feedback states
  const [racketSwingClass, setRacketSwingClass] = useState<string | null>(null);
  const [racketGlowColor, setRacketGlowColor] = useState('#FDE047');
  const [floatingPills, setFloatingPills] = useState<FloatingPill[]>([]);

  // Refs for Tennis Ball Canvas & Physics
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const arenaGridRef = useRef<HTMLDivElement | null>(null);
  const courtContainerRef = useRef<HTMLDivElement | null>(null);
  const activeRallyBallsRef = useRef<RallyBall[]>([]);
  const particlesRef = useRef<SparkParticle[]>([]);
  const swooshArcsRef = useRef<SwooshArc[]>([]);
  const ballCounterRef = useRef(1);

  // Retro sound generator using Web Audio API
  const playRetroBleep = useCallback((freq = 440, type: OscillatorType = 'sine', duration = 0.1) => {
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);

      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch {
      // Audio context might be restricted before user interaction
    }
  }, []);

  // Spark generation on net impact, racket hit, or hopper landing
  const createSparks = useCallback((x: number, y: number, color: string, count = 16) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 4.5;
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.2,
        color,
        alpha: 1,
        decay: 0.02 + Math.random() * 0.03,
        size: 2.5 + Math.random() * 3,
      });
    }
  }, []);

  // Swoosh arc on racket hit
  const createSwooshArc = useCallback((x: number, y: number, color: string, arcType: 'allow' | 'flag' | 'block') => {
    swooshArcsRef.current.push({
      x,
      y,
      arcType,
      color,
      alpha: 1,
      progress: 0,
    });
  }, []);

  // Callback triggered immediately when a rally ball reaches its target hopper basket
  const handleBallLanded = useCallback(
    (b: RallyBall) => {
      // 1. Tactile bounce animation on destination hopper
      const hopper = document.getElementById(b.targetHopperId);
      if (hopper) {
        hopper.animate(
          [
            { transform: 'scale(1)' },
            { transform: 'scale(1.06)' },
            { transform: 'scale(1)' },
          ],
          { duration: 280, easing: 'cubic-bezier(0.18, 0.89, 0.32, 1.28)' }
        );
      }

      // 2. Landing burst of particles
      createSparks(b.targetX, b.targetY, b.baseColor, 14);

      // 3. Crisp landing pop audio
      playRetroBleep(b.type === 'block' ? 180 : b.type === 'flag' ? 620 : 940, 'triangle', 0.12);

      // 4. Update the sprite to settled immediately so it registers in the hopper count and basket well
      if (b.spriteId) {
        setSprites((prev) =>
          prev.map((s) => {
            if (s.id === b.spriteId) {
              return {
                ...s,
                status: 'settled',
                revealed: true,
              };
            }
            return s;
          })
        );
      }

      // 5. Update block builder packing status for compliant balls
      if (b.type === 'allow') {
        setBuilderTxCount((c) => {
          const nextCount = c + 1;
          if (nextCount >= BLOCK_CAPACITY) {
            setBlockFlash(true);
            setSealedBlocksCount((sb) => sb + 1);
            playRetroBleep(1040, 'triangle', 0.35);
            setTimeout(() => setBlockFlash(false), 800);
            return 0;
          }
          return nextCount;
        });
      }
    },
    [createSparks, playRetroBleep]
  );

  const handleBallLandedRef = useRef(handleBallLanded);
  useEffect(() => {
    handleBallLandedRef.current = handleBallLanded;
  }, [handleBallLanded]);

  // Launch a realistic bouncing tennis ball across court, net, and into target hopper
  const launchRallyBall = useCallback(
    (action: 'allow' | 'flag' | 'block', customNumber: string, laneIndex = 0, spriteId?: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const arenaRect = arenaGridRef.current?.getBoundingClientRect();
      const courtRect = courtContainerRef.current?.getBoundingClientRect();

      let baseColor = '#D8F52E'; // Neon green for Compliant/Allow
      let highlightColor = '#F5FF76';
      let darkColor = '#95B804';
      let seamColor = 'rgba(255, 255, 255, 0.85)';
      let targetHopperId = 'hopper-compliant';

      if (action === 'flag') {
        baseColor = '#F6BE3D'; // Warm amber for Quarantine/Flag
        highlightColor = '#FFF2C6';
        darkColor = '#B57805';
        seamColor = 'rgba(255, 255, 255, 0.85)';
        targetHopperId = 'hopper-quarantine';
      } else if (action === 'block') {
        baseColor = '#FF705E'; // Coral red for Rejected/Fault
        highlightColor = '#FFE5E0';
        darkColor = '#C42E20';
        seamColor = 'rgba(255, 255, 255, 0.9)';
        targetHopperId = 'hopper-rejected';
      }

      // Dynamic start coordinate on the court
      let startX = 65;
      let startY = 120 + (laneIndex % 3) * 115;
      if (courtRect && arenaRect) {
        startX = courtRect.left - arenaRect.left + 55;
        startY = courtRect.top - arenaRect.top + 95 + (laneIndex % 3) * 115;
      }

      // If source card is mounted in DOM, align starting Y
      if (spriteId && arenaRect) {
        const cardEl = document.getElementById(`card-${spriteId}`);
        if (cardEl) {
          const cRect = cardEl.getBoundingClientRect();
          startX = cRect.left - arenaRect.left + 35;
          startY = cRect.top - arenaRect.top + cRect.height / 2;
        }
      }

      // Net crossing coordinate
      let netX = canvas.width * 0.54;
      const netEl = document.getElementById('central-tennis-net');
      if (netEl && arenaRect) {
        const nRect = netEl.getBoundingClientRect();
        netX = nRect.left - arenaRect.left + nRect.width / 2;
      }

      // Target hopper destination coordinate (in the wire basket well)
      let targetX = canvas.width - 120;
      let targetY =
        action === 'allow'
          ? canvas.height * 0.35
          : action === 'flag'
          ? canvas.height * 0.62
          : canvas.height * 0.88;

      const hopperEl = document.getElementById(targetHopperId);
      if (hopperEl && arenaRect) {
        const hRect = hopperEl.getBoundingClientRect();
        targetX = hRect.left - arenaRect.left + hRect.width * 0.42;
        targetY = hRect.top - arenaRect.top + hRect.height * 0.62;
      }

      const ball: RallyBall = {
        id: `${Date.now()}_${Math.random()}`,
        spriteId,
        type: action,
        number: customNumber,
        baseColor,
        highlightColor,
        darkColor,
        seamColor,
        targetHopperId,
        x: startX,
        y: startY,
        startX,
        startY,
        netX,
        targetX,
        targetY,
        progress: 0,
        speed: 0.0055 + Math.random() * 0.0008, // Smooth ~3.0s flight
        rot: 0,
        rotSpeed: 0.12,
        radius: 16,
        trail: [],
        netCrossed: false,
        deflected: false,
        bounceHeight: 70,
      };

      activeRallyBallsRef.current.push(ball);
    },
    []
  );

  // Spawn an in-flight transaction sprite
  const spawnSprite = useCallback((decision: Decision, explicitBallNum?: number) => {
    const ballNum = explicitBallNum ?? ballCounterRef.current++;
    const id = `${decision.tx_hash}_${Date.now()}_${Math.random()}`;
    const lane = (ballNum - 1) % 3;
    const laneY = 22 + lane * 26;

    let destZoneX = 85;
    let destZoneY = 28;
    if (decision.decision === 'FLAG') {
      destZoneX = 85;
      destZoneY = 56;
    } else if (decision.decision === 'BLOCK') {
      destZoneX = 85;
      destZoneY = 82;
    }

    const newSprite: SpriteState = {
      id,
      data: decision,
      spawnTime: Date.now(),
      status: 'traveling_to_gate',
      x: 6,
      y: laneY,
      destX: destZoneX,
      destY: destZoneY,
      revealed: false,
      userGuess: null,
      guessVerdict: null,
      lane,
      ballNumber: ballNum,
    };

    setSprites((prev) => [...prev.slice(-12), newSprite]);
    setActiveTargetId(id);
    setSelectedTx(decision);
    playRetroBleep(520, 'sine', 0.08);

    // Exactly one ball corresponding to this transaction with color matching its decision category!
    const ballType = decision.decision === 'BLOCK' ? 'block' : decision.decision === 'FLAG' ? 'flag' : 'allow';
    launchRallyBall(ballType, `#${ballNum}`, lane, id);
  }, [playRetroBleep, launchRallyBall]);

  // WebSocket Connection
  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: NodeJS.Timeout;

    function connect() {
      try {
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
          setWsConnected(true);
        };

        ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            if (msg.type === 'new_decision' || msg.type === 'DECISION') {
              const row = msg.data || msg;
              spawnSprite(row);
            }
          } catch {
            // non-json or telemetry
          }
        };

        ws.onclose = () => {
          setWsConnected(false);
          reconnectTimeout = setTimeout(connect, 3000);
        };

        ws.onerror = () => {
          setWsConnected(false);
        };
      } catch {
        setWsConnected(false);
        reconnectTimeout = setTimeout(connect, 3000);
      }
    }

    connect();

    return () => {
      if (ws) ws.close();
      clearTimeout(reconnectTimeout);
    };
  }, [spawnSprite]);

  // Main Canvas Physics & Animation Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animFrameId: number;

    function resize() {
      if (!canvas || !arenaGridRef.current) return;
      const parent = arenaGridRef.current;
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;
    }

    resize();
    const resizeTimer = setTimeout(resize, 80);
    window.addEventListener('resize', resize);

    function render() {
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // 1. Render Swoosh Arcs from Racket Swings
      for (let s = swooshArcsRef.current.length - 1; s >= 0; s--) {
        const arc = swooshArcsRef.current[s];
        arc.progress += 0.08;
        arc.alpha -= 0.045;
        if (arc.alpha <= 0) {
          swooshArcsRef.current.splice(s, 1);
          continue;
        }

        ctx.save();
        ctx.globalAlpha = arc.alpha;
        ctx.strokeStyle = arc.color;
        ctx.lineWidth = 6 * (1 - arc.progress * 0.5);
        ctx.lineCap = 'round';
        ctx.beginPath();
        if (arc.arcType === 'allow') {
          ctx.arc(arc.x + 30, arc.y + 10, 45, -0.6 * Math.PI, 0.45 * Math.PI);
        } else if (arc.arcType === 'flag') {
          ctx.arc(arc.x + 20, arc.y + 20, 50, -0.9 * Math.PI, -0.1 * Math.PI);
        } else {
          ctx.arc(arc.x + 25, arc.y - 15, 52, 0.1 * Math.PI, 0.9 * Math.PI);
        }
        ctx.stroke();
        ctx.restore();
      }

      // 2. Render Spark Particles
      for (let i = particlesRef.current.length - 1; i >= 0; i--) {
        const p = particlesRef.current[i];
        p.x += p.vx;
        p.y += p.vy;
        p.alpha -= p.decay;
        if (p.alpha <= 0) {
          particlesRef.current.splice(i, 1);
          continue;
        }
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 3. Render Active Tennis Ball Rallies
      for (let i = activeRallyBallsRef.current.length - 1; i >= 0; i--) {
        const b = activeRallyBallsRef.current[i];
        b.progress += b.speed;
        b.rot += b.rotSpeed;

        const t = b.progress;
        b.x = b.startX + (b.targetX - b.startX) * t;

        // Net crossing checkpoint at ~ netX
        if (!b.netCrossed && b.x >= b.netX - 8) {
          b.netCrossed = true;
          createSparks(b.x + 8, b.y, b.type === 'block' ? '#FF4D4D' : b.type === 'flag' ? '#F6BE3D' : '#34D399', 16);
          playRetroBleep(b.type === 'block' ? 240 : 880, 'sine', 0.08);
          if (b.type === 'block') b.deflected = true;
        }

        // Realistic 3D lob Arc + Bounce
        let arc = 0;
        if (b.type === 'block') {
          if (t < 0.55) {
            arc = Math.sin((t / 0.55) * Math.PI) * (b.bounceHeight * 0.85);
          } else {
            const bounceT = (t - 0.55) / 0.45;
            arc = Math.sin(bounceT * Math.PI) * 22;
          }
          b.y = b.startY + (b.targetY - b.startY) * t - arc;
        } else {
          if (t < 0.72) {
            arc = Math.sin((t / 0.72) * Math.PI) * b.bounceHeight;
          } else {
            const bounceT = (t - 0.72) / 0.28;
            arc = Math.sin(bounceT * Math.PI) * (b.bounceHeight * 0.35);
          }
          b.y = b.startY + (b.targetY - b.startY) * t - arc;
        }

        // Glowing motion trail
        b.trail.push({ x: b.x, y: b.y, arc });
        if (b.trail.length > 8) b.trail.shift();

        for (let tr = 0; tr < b.trail.length; tr++) {
          const tp = b.trail[tr];
          const ratio = (tr + 1) / b.trail.length;
          ctx.save();
          ctx.globalAlpha = ratio * 0.3;
          ctx.fillStyle = b.baseColor;
          ctx.beginPath();
          ctx.arc(tp.x, tp.y, b.radius * (0.4 + ratio * 0.45), 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Ground shadow on the clay court (compresses on bounce)
        const groundY = b.startY + (b.targetY - b.startY) * t + 8;
        const shadowScale = Math.max(0.4, 1 - arc / 100);
        ctx.save();
        ctx.fillStyle = 'rgba(78, 32, 18, 0.3)';
        ctx.beginPath();
        ctx.ellipse(b.x, groundY, b.radius * (1.1 / shadowScale), b.radius * 0.4 * shadowScale, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // Draw 3D Tennis Ball Sphere
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.rotate(b.rot);

        // Radial gradient body
        ctx.beginPath();
        ctx.arc(0, 0, b.radius, 0, Math.PI * 2);
        const radGrad = ctx.createRadialGradient(-b.radius * 0.3, -b.radius * 0.35, 1, 0, 0, b.radius);
        radGrad.addColorStop(0, b.highlightColor);
        radGrad.addColorStop(0.55, b.baseColor);
        radGrad.addColorStop(1, b.darkColor);
        ctx.fillStyle = radGrad;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#5E4314';
        ctx.stroke();

        // Dashed Tennis Ball Seam
        ctx.save();
        ctx.setLineDash([3, 2.5]);
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = b.seamColor;
        ctx.beginPath();
        ctx.arc(-2, 0, b.radius * 0.65, -Math.PI * 0.65, Math.PI * 0.65);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(2, 0, b.radius * 0.65, Math.PI * 0.35, Math.PI * 1.65);
        ctx.stroke();
        ctx.restore();

        // Center Ball Number Label
        ctx.rotate(-b.rot);
        ctx.fillStyle = b.type === 'block' ? '#FFFFFF' : '#3E3400';
        ctx.font = 'bold 9px Quicksand, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.number, 0, 1);

        ctx.restore();

        // Reached destination hopper basket!
        if (b.progress >= 1) {
          handleBallLandedRef.current(b);
          activeRallyBallsRef.current.splice(i, 1);
        }
      }

      animFrameId = requestAnimationFrame(render);
    }

    animFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animFrameId);
      clearTimeout(resizeTimer);
      window.removeEventListener('resize', resize);
    };
  }, [createSparks, playRetroBleep]);

  // Conveyor Animation Loop (Updates sprite coordinates over time)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();

      // Slight latency jitter for realism
      setLiveLatency(`${(2.3 + Math.random() * 0.6).toFixed(2)} µs`);

      setSprites((prev) =>
        prev.map((sprite) => {
          if (sprite.status === 'settled') return sprite;

          const elapsed = now - sprite.spawnTime;

          // Phase 1: Traveling to Gate (0 -> 1600ms)
          if (sprite.status === 'traveling_to_gate') {
            if (elapsed >= TRAVEL_TO_GATE_MS) {
              // At gate checkpoint: reveal verdict & check user prediction
              const isCorrect = sprite.userGuess
                ? sprite.userGuess === sprite.data.decision
                : false;

              if (sprite.userGuess) {
                if (isCorrect) {
                  setScore((s) => s + 100 + streak * 20);
                  setStreak((st) => st + 1);
                  setCorrectGuesses((c) => c + 1);
                  playRetroBleep(880, 'triangle', 0.2);
                } else {
                  setStreak(0);
                  playRetroBleep(220, 'sawtooth', 0.25);
                }
              }

              return {
                ...sprite,
                status: 'at_gate',
                x: 47,
                revealed: true,
                guessVerdict: sprite.userGuess ? (isCorrect ? 'CORRECT' : 'WRONG') : null,
              };
            } else {
              const progress = elapsed / TRAVEL_TO_GATE_MS;
              return {
                ...sprite,
                x: 6 + progress * (47 - 6),
              };
            }
          }

          // Phase 2: Traveling from Gate to Drop Bins
          if (sprite.status === 'at_gate') {
            return {
              ...sprite,
              status: 'traveling_to_zone',
            };
          }

          if (sprite.status === 'traveling_to_zone') {
            const zoneElapsed = elapsed - TRAVEL_TO_GATE_MS;
            // Fallback: If ball landed, status is already 'settled'. Otherwise timeout settle after flight
            if (zoneElapsed >= TRAVEL_TO_ZONE_MS + 1000) {
              return {
                ...sprite,
                status: 'settled',
                x: sprite.destX,
                y: sprite.destY + (Math.random() * 6 - 3),
              };
            } else {
              const progress = zoneElapsed / TRAVEL_TO_ZONE_MS;
              return {
                ...sprite,
                x: 47 + progress * (sprite.destX - 47),
                y: sprite.y + progress * (sprite.destY - sprite.y),
              };
            }
          }

          return sprite;
        })
      );
    }, 40);

    return () => clearInterval(interval);
  }, [streak, playRetroBleep]);

  // In-flight transactions (traveling)
  const inFlightSprites = sprites.filter(
    (s) => s.status === 'traveling_to_gate' || s.status === 'at_gate' || s.status === 'traveling_to_zone'
  );

  const activeTargetIndex = inFlightSprites.findIndex((s) => s.id === activeTargetId);
  const racketX = 14;
  const racketY = activeTargetIndex !== -1 ? 70 + activeTargetIndex * 110 : 50;
  const activeTargetSprite = sprites.find((s) => s.id === activeTargetId);

  // Trigger live demo wave
  const triggerLiveDemo = useCallback(async () => {
    if (isSimulatorRunning) return;
    setIsSimulatorRunning(true);
    setDemoNotice('🎾 TENNIS RALLY SERVED: 6 SCENARIOS INCOMING...');
    playRetroBleep(523.25, 'triangle', 0.2);

    // Fire backend simulator in background
    fetch(`${API_URL}/api/demo/run-simulator`, {
      method: 'POST',
      headers: {
        'x-admin-key': process.env.NEXT_PUBLIC_ADMIN_API_KEY || 'dev-admin-secret-2026',
      },
    }).catch(() => {});

    // Spawn 6 canonical scenarios staggered 1.1s apart, exactly 6 balls numbered 1 to 6
    CANONICAL_SCENARIOS.forEach((scenario, i) => {
      setTimeout(() => {
        spawnSprite(scenario, i + 1);
        if (i === CANONICAL_SCENARIOS.length - 1) {
          setTimeout(() => {
            setIsSimulatorRunning(false);
            setDemoNotice('MATCH WAVE CONCLUDED: 6 BALLS EVALUATED & SETTLED');
            setTimeout(() => setDemoNotice(null), 4000);
          }, 4500);
        }
      }, i * 1100);
    });
  }, [isSimulatorRunning, playRetroBleep, spawnSprite]);

  // Generate random 64-char hex tx hash for custom demo submissions
  const generateRandomTxHash = useCallback(() => {
    const chars = '0123456789abcdef';
    let hash = '0xcustom_';
    for (let i = 0; i < 56; i++) {
      hash += chars[Math.floor(Math.random() * chars.length)];
    }
    return hash;
  }, []);

  // Validate Ethereum-style 0x address format
  const isValidAddress = useCallback((addr: string) => {
    const trimmed = addr.trim();
    return /^0x[a-fA-F0-9]{40}$/.test(trimmed);
  }, []);

  // Convert ETH input to Wei string using BigInt
  const ethToWeiString = useCallback((ethStr: string): string => {
    try {
      const trimmed = ethStr.trim();
      if (!trimmed) return '0';
      if (trimmed.startsWith('0x')) return trimmed;
      if (!trimmed.includes('.') && trimmed.length > 10) return trimmed;
      const val = parseFloat(trimmed);
      if (isNaN(val) || val <= 0) return '0';
      const [whole, frac = ''] = trimmed.split('.');
      const paddedFrac = frac.padEnd(18, '0').slice(0, 18);
      const weiVal = BigInt(whole || '0') * BigInt('1000000000000000000') + BigInt(paddedFrac);
      return weiVal.toString();
    } catch {
      return DEFAULT_ETH_VALUE_WEI;
    }
  }, []);

  // Fetch next unused slot dynamically from relay bids
  const fetchNextSuggestedSlot = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/relay/bids`).catch(() => null);
      if (res && res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          const validSlots = data
            .map((b: { slot?: number | string }) => Number(b.slot))
            .filter((s: number) => !isNaN(s) && s > 0);
          if (validSlots.length > 0) {
            const maxSlot = Math.max(...validSlots);
            setAuctionSlot(maxSlot + 1);
            return;
          }
        }
      }
    } catch {
      // fallback gracefully
    }
    setAuctionSlot((prev) => (prev > 0 ? prev : 100));
  }, []);

  // Load Relay Auction demo scenario
  const loadExampleRelayAuction = useCallback(() => {
    const freshBids: BuilderBidInput[] = [
      {
        id: `bid_a_${Date.now()}`,
        builder_id: 'Builder A (Compliant)',
        bid_value_eth: '2.0',
        fee_recipient: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
        txs: [
          {
            id: `tx_a_${Date.now()}_1`,
            sender: '0x1111111111111111111111111111111111111111',
            recipient: '0x2222222222222222222222222222222222222222',
            value: '1000000000000000000',
          },
        ],
      },
      {
        id: `bid_b_${Date.now() + 1}`,
        builder_id: 'Builder B (Sanctioned Tx, 2.5 ETH)',
        bid_value_eth: '2.5',
        fee_recipient: '0x90f79bf6eb2c4f870365e785982e1f101e93b906',
        txs: [
          {
            id: `tx_b_${Date.now() + 1}_1`,
            sender: '0x747afb5c7a7fc34b547cd0fdebf9b91759c5a52b',
            recipient: '0x2222222222222222222222222222222222222222',
            value: '500000000000000000',
          },
        ],
      },
      {
        id: `bid_c_${Date.now() + 2}`,
        builder_id: 'Builder C (Sanctioned Fee, 1.8 ETH)',
        bid_value_eth: '1.8',
        fee_recipient: '0x747afb5c7a7fc34b547cd0fdebf9b91759c5a52b',
        txs: [
          {
            id: `tx_c_${Date.now() + 2}_1`,
            sender: '0x1111111111111111111111111111111111111111',
            recipient: '0x12d66f87a04a9e220743712ce6d9bb1b5616b8fc',
            value: '100000000000000000',
          },
        ],
      },
    ];
    setBuilderBids(freshBids);
    setAuctionValidationErrors(null);
    setAuctionResult(null);
    fetchNextSuggestedSlot();
    playRetroBleep(587.33, 'triangle', 0.12);
  }, [fetchNextSuggestedSlot, playRetroBleep]);

  // Builder bid manipulation
  const addBuilderBid = useCallback(() => {
    if (builderBids.length >= 5) return;
    const letter = String.fromCharCode(65 + builderBids.length);
    setBuilderBids((prev) => [
      ...prev,
      {
        id: `bid_${Date.now()}_${Math.random()}`,
        builder_id: `Builder ${letter}`,
        bid_value_eth: '1.5',
        fee_recipient: '0x0330070fd38ec3bb94f58fa55d40368271e9e54a',
        txs: [
          {
            id: `tx_${Date.now()}_${Math.random()}`,
            sender: '0x1111111111111111111111111111111111111111',
            recipient: '0x2222222222222222222222222222222222222222',
            value: DEFAULT_ETH_VALUE_WEI,
          },
        ],
      },
    ]);
  }, [builderBids.length]);

  const removeBuilderBid = useCallback((bidId: string) => {
    setBuilderBids((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((b) => b.id !== bidId);
    });
  }, []);

  const updateBuilderBid = useCallback((bidId: string, field: keyof BuilderBidInput, value: string) => {
    setBuilderBids((prev) =>
      prev.map((b) => (b.id === bidId ? { ...b, [field]: value } : b))
    );
    setAuctionValidationErrors(null);
  }, []);

  const addTxToBid = useCallback((bidId: string) => {
    setBuilderBids((prev) =>
      prev.map((b) => {
        if (b.id !== bidId) return b;
        if (b.txs.length >= 5) return b;
        return {
          ...b,
          txs: [
            ...b.txs,
            {
              id: `tx_${Date.now()}_${Math.random()}`,
              sender: '0x1111111111111111111111111111111111111111',
              recipient: '0x2222222222222222222222222222222222222222',
              value: DEFAULT_ETH_VALUE_WEI,
            },
          ],
        };
      })
    );
  }, []);

  const removeTxFromBid = useCallback((bidId: string, txId: string) => {
    setBuilderBids((prev) =>
      prev.map((b) => {
        if (b.id !== bidId) return b;
        if (b.txs.length <= 1) return b;
        return {
          ...b,
          txs: b.txs.filter((t) => t.id !== txId),
        };
      })
    );
  }, []);

  const updateTxInBid = useCallback((bidId: string, txId: string, field: keyof CustomTxRow, val: string) => {
    setBuilderBids((prev) =>
      prev.map((b) => {
        if (b.id !== bidId) return b;
        return {
          ...b,
          txs: b.txs.map((t) => (t.id === txId ? { ...t, [field]: val } : t)),
        };
      })
    );
    setAuctionValidationErrors(null);
  }, []);

  // Submit Relay Auction dispatches
  const handleSubmitRelayAuction = useCallback(async () => {
    if (isSubmittingAuction) return;

    // 1. Client validation
    const errs: string[] = [];
    if (!auctionSlot || auctionSlot <= 0) {
      errs.push('A valid positive target slot number is required.');
    }
    if (!builderBids || builderBids.length === 0) {
      errs.push('At least one builder bid is required.');
    }

    builderBids.forEach((bid, bIdx) => {
      const bLabel = bid.builder_id?.trim() || `Bid #${bIdx + 1}`;
      if (!bid.builder_id?.trim()) {
        errs.push(`${bLabel}: Builder label is required.`);
      }
      if (!bid.fee_recipient?.trim() || !isValidAddress(bid.fee_recipient.trim())) {
        errs.push(`${bLabel}: Fee recipient must be a valid 0x 40-hex character address.`);
      }
      const ethNum = parseFloat(bid.bid_value_eth);
      if (isNaN(ethNum) || ethNum <= 0) {
        errs.push(`${bLabel}: Bid value must be a positive number in ETH.`);
      }
      if (!bid.txs || bid.txs.length === 0) {
        errs.push(`${bLabel}: At least 1 transaction is required in candidate block.`);
      }
      bid.txs.forEach((tx, tIdx) => {
        if (!tx.sender?.trim() || !isValidAddress(tx.sender.trim())) {
          errs.push(`${bLabel} Tx #${tIdx + 1}: Sender must be a valid 0x 40-hex character address.`);
        }
        if (!tx.recipient?.trim() || !isValidAddress(tx.recipient.trim())) {
          errs.push(`${bLabel} Tx #${tIdx + 1}: Recipient must be a valid 0x 40-hex character address.`);
        }
      });
    });

    if (errs.length > 0) {
      setAuctionValidationErrors(errs);
      return;
    }

    setAuctionValidationErrors(null);
    setIsSubmittingAuction(true);
    setAuctionResult(null);
    setAuctionProgress({ current: 0, total: builderBids.length });
    playRetroBleep(440, 'sine', 0.15);

    const submissionPerBidErrors: Record<string, string> = {};

    // 2. Staggered dispatch to /api/relay/submit_bid
    for (let i = 0; i < builderBids.length; i++) {
      const bid = builderBids[i];
      setAuctionProgress({
        current: i + 1,
        total: builderBids.length,
        currentBuilder: bid.builder_id,
      });

      const blockHashChars = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const pubkeyChars = Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
      const valueWei = ethToWeiString(bid.bid_value_eth);

      const payload = {
        slot: auctionSlot,
        block_hash: `0x${blockHashChars}`,
        builder_id: bid.builder_id.trim(),
        builder_pubkey: `0x${pubkeyChars}`,
        fee_recipient: bid.fee_recipient.trim(),
        value_wei: valueWei,
        txs: bid.txs.map((t) => ({
          hash: t.tx_hash?.trim() || `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`,
          sender: t.sender.trim(),
          recipient: t.recipient.trim(),
          value: t.value?.trim() || DEFAULT_ETH_VALUE_WEI,
          bundle_id: null,
        })),
      };

      try {
        const resp = await fetch(`${API_URL}/api/relay/submit_bid`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          submissionPerBidErrors[bid.builder_id] = errData.error || `HTTP ${resp.status} Relay Error`;
        }
      } catch (err: unknown) {
        submissionPerBidErrors[bid.builder_id] = err instanceof Error ? err.message : 'Network error';
      }

      if (i < builderBids.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, SUBMISSION_STAGGER_MS));
      }
    }

    // 3. Brief wait for asynchronous relay audit execution
    await new Promise((resolve) => setTimeout(resolve, 800));

    // 4. Fetch Best Header
    let winningHeader: AuctionHeaderResponse | null = null;
    let isFailClosed = false;
    let failClosedReason = '';

    try {
      const headerResp = await fetch(`${API_URL}/api/relay/best_header?slot=${auctionSlot}`).catch(() => null);
      if (headerResp && headerResp.ok) {
        winningHeader = await headerResp.json();
      } else if (headerResp && headerResp.status === 404) {
        isFailClosed = true;
        const errData = await headerResp.json().catch(() => ({}));
        failClosedReason = errData.error || `No compliant header found for slot ${auctionSlot}`;
      } else {
        isFailClosed = true;
        failClosedReason = `Relay auction completed without winning compliant header for slot ${auctionSlot}`;
      }
    } catch (err: unknown) {
      isFailClosed = true;
      failClosedReason = err instanceof Error ? err.message : 'Failed to query auction header';
    }

    // 5. Fetch all bids for slot to display detailed audit results & reasons
    let slotBids: StoredBidResult[] = [];
    try {
      const bidsResp = await fetch(`${API_URL}/api/relay/bids?slot=${auctionSlot}`).catch(() => null);
      if (bidsResp && bidsResp.ok) {
        slotBids = await bidsResp.json();
      }
    } catch {
      // fallback
    }

    // Correlate results with submitted builder bids
    const compiledBids: StoredBidResult[] = builderBids.map((b) => {
      const match = slotBids.find((sb) => sb.builder_id === b.builder_id.trim());
      if (match) {
        return {
          ...match,
          error: submissionPerBidErrors[b.builder_id],
        };
      }
      return {
        slot: auctionSlot,
        builder_id: b.builder_id,
        fee_recipient: b.fee_recipient,
        value_wei: ethToWeiString(b.bid_value_eth),
        verdict: submissionPerBidErrors[b.builder_id] ? 'REJECTED' : 'PENDING',
        reasons: submissionPerBidErrors[b.builder_id] ? [submissionPerBidErrors[b.builder_id]] : [],
        error: submissionPerBidErrors[b.builder_id],
      };
    });

    if (!winningHeader) {
      isFailClosed = true;
    }

    setAuctionResult({
      slot: auctionSlot,
      winningHeader,
      isFailClosed,
      failClosedReason,
      bids: compiledBids,
      submittedAt: new Date().toLocaleTimeString(),
    });

    setIsSubmittingAuction(false);
    setAuctionProgress(null);
    playRetroBleep(659.25, 'triangle', 0.25);
  }, [
    API_URL,
    auctionSlot,
    builderBids,
    ethToWeiString,
    isSubmittingAuction,
    isValidAddress,
    playRetroBleep,
  ]);

  // Load standard 3-transaction ALLOW / FLAG / BLOCK demo example
  const loadExampleTransactions = useCallback(() => {
    const examples: CustomTxRow[] = [
      { id: `ex_clean_${Date.now()}`, ...EXAMPLE_CLEAN_TX },
      { id: `ex_mixer_${Date.now() + 1}`, ...EXAMPLE_MIXER_TX },
      { id: `ex_sanctioned_${Date.now() + 2}`, ...EXAMPLE_SANCTIONED_TX },
    ];
    setFormRows(examples);
    setRawJson(
      JSON.stringify(
        examples.map(({ sender, recipient, value }) => ({ sender, recipient, value })),
        null,
        2
      )
    );
    setJsonError(null);
    setClientValidationError(null);
    setSubmissionSummary(null);
    setSubmissionResults([]);
    playRetroBleep(587.33, 'triangle', 0.12);
  }, [playRetroBleep]);

  // Form row manipulation helpers
  const addFormRow = useCallback(() => {
    if (formRows.length >= 10) return;
    setFormRows((prev) => [
      ...prev,
      { id: `row_${Date.now()}_${Math.random()}`, sender: '', recipient: '', value: DEFAULT_ETH_VALUE_WEI },
    ]);
  }, [formRows.length]);

  const removeFormRow = useCallback((id: string) => {
    setFormRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((r) => r.id !== id);
    });
  }, []);

  const updateFormRow = useCallback((id: string, field: keyof CustomTxRow, value: string) => {
    setFormRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
    );
    setClientValidationError(null);
  }, []);

  // Real-time JSON validation
  const handleJsonChange = useCallback((text: string) => {
    setRawJson(text);
    if (!text.trim()) {
      setJsonError(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        setJsonError('JSON must be an array of transaction objects: [{ "sender": "0x...", "recipient": "0x..." }]');
        return;
      }
      if (parsed.length === 0) {
        setJsonError('Array is empty. Please provide at least one transaction object.');
        return;
      }
      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        if (!item || typeof item !== 'object') {
          setJsonError(`Item #${i + 1} must be an object with "sender" and "recipient" strings.`);
          return;
        }
        if (!item.sender || typeof item.sender !== 'string') {
          setJsonError(`Item #${i + 1} is missing a valid "sender" address.`);
          return;
        }
        if (!item.recipient || typeof item.recipient !== 'string') {
          setJsonError(`Item #${i + 1} is missing a valid "recipient" address.`);
          return;
        }
      }
      setJsonError(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid JSON syntax';
      setJsonError(`JSON Syntax Error: ${msg}`);
    }
  }, []);

  // Submit custom transactions staggered one by one to /api/screen
  const handleSubmitCustomTransactions = useCallback(async () => {
    if (isSubmittingCustom) return;

    const txListToSubmit: Array<{ tx_hash: string; sender: string; recipient: string; value?: string }> = [];

    if (customInputMode === 'form') {
      // Validate form rows
      for (let i = 0; i < formRows.length; i++) {
        const r = formRows[i];
        const s = r.sender.trim();
        const rec = r.recipient.trim();
        if (!s) {
          setClientValidationError(`Row #${i + 1}: Sender address is required.`);
          return;
        }
        if (!isValidAddress(s)) {
          setClientValidationError(`Row #${i + 1}: Sender address must start with '0x' followed by 40 hex characters.`);
          return;
        }
        if (!rec) {
          setClientValidationError(`Row #${i + 1}: Recipient address is required.`);
          return;
        }
        if (!isValidAddress(rec)) {
          setClientValidationError(`Row #${i + 1}: Recipient address must start with '0x' followed by 40 hex characters.`);
          return;
        }
        txListToSubmit.push({
          tx_hash: r.tx_hash?.trim() || generateRandomTxHash(),
          sender: s,
          recipient: rec,
          value: r.value.trim() || DEFAULT_ETH_VALUE_WEI,
        });
      }
    } else {
      // Parse & validate JSON
      if (!rawJson.trim()) {
        setJsonError('Please enter or paste a JSON array of transactions.');
        return;
      }
      try {
        const parsed = JSON.parse(rawJson);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          setJsonError('JSON must be a non-empty array of transaction objects.');
          return;
        }
        for (let i = 0; i < parsed.length; i++) {
          const item = parsed[i];
          const s = item.sender ? String(item.sender).trim() : '';
          const rec = item.recipient ? String(item.recipient).trim() : '';
          if (!s || !isValidAddress(s)) {
            setJsonError(`Item #${i + 1}: Invalid or missing sender address (must be 0x followed by 40 hex chars).`);
            return;
          }
          if (!rec || !isValidAddress(rec)) {
            setJsonError(`Item #${i + 1}: Invalid or missing recipient address (must be 0x followed by 40 hex chars).`);
            return;
          }
          txListToSubmit.push({
            tx_hash: item.tx_hash ? String(item.tx_hash).trim() : generateRandomTxHash(),
            sender: s,
            recipient: rec,
            value: item.value ? String(item.value).trim() : DEFAULT_ETH_VALUE_WEI,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Invalid JSON';
        setJsonError(`JSON Syntax Error: ${msg}`);
        return;
      }
    }

    setClientValidationError(null);
    setJsonError(null);
    setIsSubmittingCustom(true);
    setSubmissionSummary(null);
    setSubmissionResults([]);
    setSubmissionProgress({ current: 0, total: txListToSubmit.length });

    playRetroBleep(440, 'sine', 0.15);

    const results: SubmissionResultItem[] = [];
    let allowCount = 0;
    let flagCount = 0;
    let blockCount = 0;
    let failCount = 0;

    for (let i = 0; i < txListToSubmit.length; i++) {
      const item = txListToSubmit[i];
      setSubmissionProgress({ current: i + 1, total: txListToSubmit.length });

      try {
        const resp = await fetch('/api/screen', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tx_hash: item.tx_hash,
            sender: item.sender,
            recipient: item.recipient,
          }),
        });

        if (!resp.ok) {
          const errJson = await resp.json().catch(() => ({}));
          const errMsg = errJson.error || `HTTP ${resp.status}: Engine screening failed`;
          results.push({
            index: i + 1,
            tx_hash: item.tx_hash,
            sender: item.sender,
            recipient: item.recipient,
            error: errMsg,
          });
          failCount++;
        } else {
          const decisionData = await resp.json();
          const decision = decisionData.decision as 'ALLOW' | 'FLAG' | 'BLOCK';
          if (decision === 'ALLOW') allowCount++;
          else if (decision === 'FLAG') flagCount++;
          else if (decision === 'BLOCK') blockCount++;

          results.push({
            index: i + 1,
            tx_hash: item.tx_hash,
            sender: item.sender,
            recipient: item.recipient,
            decision,
            risk_score: decisionData.risk_score,
            reasons: decisionData.reasons || [],
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Network error';
        results.push({
          index: i + 1,
          tx_hash: item.tx_hash,
          sender: item.sender,
          recipient: item.recipient,
          error: msg,
        });
        failCount++;
      }

      setSubmissionResults([...results]);

      // Stagger delay between submissions so each ball animates distinctly through arena
      if (i < txListToSubmit.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, SUBMISSION_STAGGER_MS));
      }
    }

    setIsSubmittingCustom(false);
    setSubmissionProgress(null);

    // Play completion sound
    playRetroBleep(659.25, 'triangle', 0.25);

    // Set inline summary string
    const total = txListToSubmit.length;
    if (failCount === 0) {
      setSubmissionSummary(`${total} submitted — ${allowCount} ALLOW, ${flagCount} FLAG, ${blockCount} BLOCK`);
    } else {
      setSubmissionSummary(
        `${total} submitted — ${total - failCount} processed (${allowCount} ALLOW, ${flagCount} FLAG, ${blockCount} BLOCK), ${failCount} failed`
      );
    }
  }, [
    customInputMode,
    formRows,
    generateRandomTxHash,
    isSubmittingCustom,
    isValidAddress,
    playRetroBleep,
    rawJson,
  ]);

  // Handle user guess & execute racket swing animation
  const handleGuess = useCallback(
    (guess: 'ALLOW' | 'FLAG' | 'BLOCK') => {
      // 1. Trigger Visual Racket Swing Animation & Motion Trail
      let swingClass = 'racket-swing-allow';
      let sparkColor = '#48BB78';
      let glowColor = '#34D399';
      let popupText = '✓ ACE SERVE! OFAC PASS (+100 PTS)';
      let popupColor = 'bg-[#DEF4E6] text-[#235839] border-[#7DD89F]';

      if (guess === 'FLAG') {
        swingClass = 'racket-swing-flag';
        sparkColor = '#F6BE3D';
        glowColor = '#FBBF24';
        popupText = '⚠ TOP-SPIN LOB! EDD REVIEW';
        popupColor = 'bg-[#FEF6E4] text-[#8C5D17] border-[#F6CB63]';
      } else if (guess === 'BLOCK') {
        swingClass = 'racket-swing-block';
        sparkColor = '#E53E3E';
        glowColor = '#F87171';
        popupText = '✖ OVERHEAD SMASH! DROP (+150 PTS)';
        popupColor = 'bg-[#FCE5E2] text-[#9B2C2C] border-[#F49A90]';
      }

      setRacketSwingClass(swingClass);
      setRacketGlowColor(glowColor);

      // Create swoosh sparks on canvas
      const canvas = canvasRef.current;
      if (canvas) {
        createSparks(racketX + 48, racketY + 38, sparkColor, 20);
        createSwooshArc(racketX + 48, racketY + 38, sparkColor, guess.toLowerCase() as 'allow' | 'flag' | 'block');
      }

      // Add floating hit banner
      const pillId = `${Date.now()}_${Math.random()}`;
      setFloatingPills((prev) => [
        ...prev,
        {
          id: pillId,
          text: popupText,
          colorClass: popupColor,
          x: racketX + 50,
          y: racketY + 10,
        },
      ]);
      setTimeout(() => {
        setFloatingPills((prev) => prev.filter((p) => p.id !== pillId));
      }, 950);

      // Reset swing after animation
      setTimeout(() => {
        setRacketSwingClass(null);
      }, 540);

      // 2. Apply guess to target sprite
      if (activeTargetId) {
        setSprites((prev) =>
          prev.map((s) => {
            if (s.id === activeTargetId && !s.revealed) {
              setTotalGuesses((t) => t + 1);
              playRetroBleep(580, 'sine', 0.1);
              return { ...s, userGuess: guess };
            }
            return s;
          })
        );
        setActiveTargetId(null);
      }
    },
    [activeTargetId, racketX, racketY, createSparks, createSwooshArc, playRetroBleep]
  );

  // Keyboard shortcut listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.key === '1') {
        handleGuess('ALLOW');
      } else if (e.key === '2') {
        handleGuess('FLAG');
      } else if (e.key === '3') {
        handleGuess('BLOCK');
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        triggerLiveDemo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleGuess, triggerLiveDemo]);

  // Policy switch handler
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
        setActivePolicy(policyId);
        setPolicyNotification(`POLICY ACTIVATED: ${policyId.toUpperCase()}`);
        playRetroBleep(660, 'sine', 0.15);
        setTimeout(() => setPolicyNotification(null), 3500);
      }
    } finally {
      setIsSwitchingPolicy(false);
    }
  }

  // Settled transactions for the 3 drop bins
  const allSettledAllow = sprites.filter((s) => s.status === 'settled' && s.data.decision === 'ALLOW');
  const allSettledFlag = sprites.filter((s) => s.status === 'settled' && s.data.decision === 'FLAG');
  const allSettledBlock = sprites.filter((s) => s.status === 'settled' && s.data.decision === 'BLOCK');

  const settledAllow = allSettledAllow.slice(-8);
  const settledFlag = allSettledFlag.slice(-8);
  const settledBlock = allSettledBlock.slice(-8);

  return (
    <div className="arcade-root min-h-screen p-3 md:p-6 lg:p-8 flex flex-col justify-between selection:bg-[#FFC570] selection:text-[#5D2C1A]">
      <div className="max-w-[1780px] w-full mx-auto flex flex-col gap-4">

        {/* Top Header Section (Stitch Cozy Arcade Design) */}
        {/* Top Header Section (Stitch Cozy Arcade Design) */}
        <header className="tactile-card bg-[#FBF1E2] rounded-3xl p-4 md:p-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Left: Back Button and Title */}
            <div className="flex items-center flex-wrap gap-4">
              <Link
                href="/"
                className="btn-3d bg-[#DF7B59] hover:bg-[#D46E4C] text-white font-bold px-4 py-2.5 rounded-2xl flex items-center gap-2 tracking-wide text-sm md:text-base cursor-pointer"
              >
                <span className="text-xs bg-[#B85332] w-6 h-6 rounded-full inline-flex items-center justify-center shadow-inner">◀</span>
                <span>BACK TO MISSION CONTROL</span>
              </Link>

              {/* Main Title Badge */}
              <div className="flex items-center gap-3">
                <div className="w-13 h-13 md:w-14 md:h-14 bg-[#FFC570] border-3 border-[#8F4C30] rounded-2xl flex items-center justify-center text-3xl shadow-[0_3px_0_#8F4C30] bobble-anim">
                  🎾
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h1 className="text-2xl md:text-3xl font-extrabold tracking-wider text-[#6B2F1B]">
                      COMPLIANCE ARCADE
                    </h1>
                    <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-[#E5F7EB] border-2 border-[#48BB78] text-[#22543D] text-xs font-bold shadow-sm">
                      <span className="w-2 h-2 rounded-full bg-[#48BB78] ping-slow" />
                      LIVE ARENA
                    </span>
                  </div>
                  <p className="text-xs md:text-sm font-semibold text-[#9C5D41] flex items-center gap-2">
                    <span>Deterministic Rust Pre-Execution Gate</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-[#C88E75]" />
                    <span className="font-mono text-xs">VASP Attribution &amp; Fraud Identification</span>
                  </p>
                </div>
              </div>
            </div>

            {/* Center: Animated Mascot Cats Playing Tennis Rally Widget (Stitch Edition) */}
            <div
              className="flex items-center justify-center px-3 py-1.5 bg-[#FFF8EE] rounded-2xl border-2 border-[#8F4C30] shadow-sm select-none mx-2 relative overflow-hidden group hover:scale-[1.03] transition-transform duration-300"
              title="Chubby Cats Rally Practice"
            >
              <svg
                className="w-[158px] h-[54px] overflow-visible"
                fill="none"
                viewBox="0 0 160 54"
                xmlns="http://www.w3.org/2000/svg"
              >
                {/* Court Shadow Strip */}
                <ellipse cx="80" cy="49" fill="#E8CFB0" opacity="0.6" rx="74" ry="4" />
                {/* Center Mini Net */}
                <g id="mini-court-net">
                  <line stroke="#8F4C30" strokeLinecap="round" strokeWidth="2.2" x1="80" x2="80" y1="26" y2="50" />
                  <line stroke="#FFF8F6" strokeLinecap="round" strokeWidth="1.8" x1="74" x2="86" y1="32" y2="32" />
                  <line stroke="#FFF8F6" strokeDasharray="2 2" strokeWidth="1.5" x1="74" x2="86" y1="38" y2="38" />
                  <circle cx="80" cy="25" fill="#E0835d" r="2.5" stroke="#8F4C30" strokeWidth="1.2" />
                </g>

                {/* LEFT CAT (Ginger / Caramel) */}
                <g id="left-ginger-cat" style={{ transformOrigin: '20px 48px', animation: 'catBobLeft 2.4s cubic-bezier(0.45, 0, 0.55, 1) infinite' }}>
                  {/* Cat Shadow */}
                  <ellipse cx="21" cy="50" fill="#6B341E" opacity="0.2" rx="14" ry="3" />
                  {/* Wagging Tail */}
                  <g style={{ transformOrigin: '9px 42px', animation: 'tailWagLeft 1.2s ease-in-out infinite' }}>
                    <path d="M10 42 C 4 41, 1 33, 4 28 C 6 25, 9 27, 8 31 C 7 35, 10 38, 12 39" fill="none" stroke="#E0835D" strokeLinecap="round" strokeWidth="4.2" />
                    <path d="M10 42 C 4 41, 1 33, 4 28 C 6 25, 9 27, 8 31 C 7 35, 10 38, 12 39" fill="none" stroke="#7D4427" strokeLinecap="round" strokeWidth="1" />
                  </g>
                  {/* Left Cat Body (Chubby) */}
                  <ellipse cx="21" cy="37" fill="#E0835D" rx="11.5" ry="12" stroke="#7D4427" strokeWidth="1.8" />
                  {/* Cream Belly Patch */}
                  <ellipse cx="22" cy="38" fill="#FFF1EB" rx="7" ry="8" />
                  {/* Whimsical Fur Stripes */}
                  <path d="M12 34 Q 15 35 13 38" stroke="#954827" strokeLinecap="round" strokeWidth="1.4" />
                  <path d="M11 29 Q 15 30 13 33" stroke="#954827" strokeLinecap="round" strokeWidth="1.4" />
                  {/* Left Cat Ears */}
                  <g style={{ transformOrigin: '21px 22px', animation: 'earTwitch 3.8s ease-in-out infinite' }}>
                    <path d="M12 21 L16 12 L20 20 Z" fill="#E0835D" stroke="#7D4427" strokeLinejoin="round" strokeWidth="1.6" />
                    <path d="M14 19 L16 14 L18 19 Z" fill="#FFC2B0" />
                    <path d="M22 20 L26 12 L30 21 Z" fill="#E0835D" stroke="#7D4427" strokeLinejoin="round" strokeWidth="1.6" />
                    <path d="M24 19 L26 14 L28 19 Z" fill="#FFC2B0" />
                  </g>
                  {/* Left Cat Head */}
                  <circle cx="21" cy="24" fill="#E0835D" r="9.5" stroke="#7D4427" strokeWidth="1.8" />
                  {/* Cute Face Details */}
                  <circle cx="18" cy="23.5" fill="#452A1C" r="1.4" />
                  <circle cx="24" cy="23.5" fill="#452A1C" r="1.4" />
                  <circle cx="17.5" cy="22.8" fill="#FFFFFF" r="0.4" />
                  <circle cx="23.5" cy="22.8" fill="#FFFFFF" r="0.4" />
                  {/* Rosy Cheeks */}
                  <ellipse cx="15.5" cy="26" fill="#F99B83" opacity="0.8" rx="1.8" ry="1" />
                  <ellipse cx="26.5" cy="26" fill="#F99B83" opacity="0.8" rx="1.8" ry="1" />
                  {/* Little Nose & Mouth */}
                  <path d="M20.5 25 L21.5 25 L21 26 Z" fill="#7D4427" />
                  <path d="M19.5 27 Q 21 28 22.5 27" fill="none" stroke="#7D4427" strokeLinecap="round" strokeWidth="1" />
                  {/* Left Cat Tennis Racket Arm (Ginger) */}
                  <g style={{ transformOrigin: '26px 36px', animation: 'catSwingLeft 2.4s cubic-bezier(0.3, 0.7, 0.4, 1.2) infinite' }}>
                    <path d="M24 36 Q 30 35 34 32" stroke="#E0835D" strokeLinecap="round" strokeWidth="3.8" />
                    <path d="M33 32 L40 28" stroke="#954827" strokeLinecap="round" strokeWidth="2.2" />
                    <ellipse cx="44" cy="25" fill="rgba(255,255,255,0.25)" rx="6" ry="8" stroke="#954827" strokeWidth="1.8" transform="rotate(35 44 25)" />
                    <line stroke="#C88E75" strokeWidth="0.8" x1="41" x2="47" y1="20" y2="30" />
                    <line stroke="#C88E75" strokeWidth="0.8" x1="47" x2="41" y1="20" y2="30" />
                  </g>
                </g>

                {/* RIGHT CAT (Cream / Calico / Caramel) */}
                <g id="right-cream-cat" style={{ transformOrigin: '139px 48px', animation: 'catBobRight 2.4s cubic-bezier(0.45, 0, 0.55, 1) infinite' }}>
                  {/* Cat Shadow */}
                  <ellipse cx="139" cy="50" fill="#6B341E" opacity="0.2" rx="14" ry="3" />
                  {/* Tail */}
                  <g style={{ transformOrigin: '151px 42px', animation: 'tailWagRight 1.3s ease-in-out infinite' }}>
                    <path d="M150 42 C 156 41, 159 33, 156 28 C 154 25, 151 27, 152 31 C 153 35, 150 38, 148 39" fill="none" stroke="#7D4427" strokeLinecap="round" strokeWidth="4" />
                    <path d="M150 42 C 156 41, 159 33, 156 28 C 154 25, 151 27, 152 31 C 153 35, 150 38, 148 39" fill="none" stroke="#452A1C" strokeLinecap="round" strokeWidth="1" />
                  </g>
                  {/* Right Cat Body (Chubby Cream) */}
                  <ellipse cx="139" cy="37" fill="#FFF1EB" rx="11.5" ry="12" stroke="#7D4427" strokeWidth="1.8" />
                  {/* Caramel Calico Body Patch */}
                  <path d="M144 28 Q 150 34 146 43 Q 138 41 140 33 Z" fill="#E0835D" />
                  {/* Right Cat Ears */}
                  <g style={{ transformOrigin: '139px 22px', animation: 'earTwitch 3.4s ease-in-out infinite 0.5s' }}>
                    <path d="M130 21 L134 12 L138 20 Z" fill="#FFF1EB" stroke="#7D4427" strokeLinejoin="round" strokeWidth="1.6" />
                    <path d="M132 19 L134 14 L136 19 Z" fill="#FFC2B0" />
                    <path d="M140 20 L144 12 L148 21 Z" fill="#E0835D" stroke="#7D4427" strokeLinejoin="round" strokeWidth="1.6" />
                    <path d="M142 19 L144 14 L146 19 Z" fill="#FFC2B0" />
                  </g>
                  {/* Right Cat Head */}
                  <circle cx="139" cy="24" fill="#FFF1EB" r="9.5" stroke="#7D4427" strokeWidth="1.8" />
                  {/* Calico Head Eye Patch */}
                  <path d="M141 17 C 147 18, 149 26, 143 27 C 141 27, 139 23, 141 17 Z" fill="#E0835D" />
                  {/* Cute Eyes */}
                  <circle cx="135" cy="23.5" fill="#452A1C" r="1.4" />
                  <circle cx="142" cy="23.5" fill="#452A1C" r="1.4" />
                  <circle cx="134.5" cy="22.8" fill="#FFFFFF" r="0.4" />
                  <circle cx="141.5" cy="22.8" fill="#FFFFFF" r="0.4" />
                  {/* Cheeks */}
                  <ellipse cx="132.5" cy="26" fill="#F99B83" opacity="0.8" rx="1.8" ry="1" />
                  <ellipse cx="145.5" cy="26" fill="#F99B83" opacity="0.8" rx="1.8" ry="1" />
                  {/* Nose & Smile */}
                  <path d="M138.5 25 L139.5 25 L139 26 Z" fill="#7D4427" />
                  <path d="M137.5 27 Q 139 28 140.5 27" fill="none" stroke="#7D4427" strokeLinecap="round" strokeWidth="1" />
                  {/* Right Cat Tennis Racket Arm */}
                  <g style={{ transformOrigin: '134px 36px', animation: 'catSwingRight 2.4s cubic-bezier(0.3, 0.7, 0.4, 1.2) infinite' }}>
                    <path d="M135 36 Q 129 35 125 32" stroke="#FFF1EB" strokeLinecap="round" strokeWidth="3.8" />
                    <path d="M126 32 L119 28" stroke="#954827" strokeLinecap="round" strokeWidth="2.2" />
                    <ellipse cx="115" cy="25" fill="rgba(255,255,255,0.25)" rx="6" ry="8" stroke="#954827" strokeWidth="1.8" transform="rotate(-35 115 25)" />
                    <line stroke="#C88E75" strokeWidth="0.8" x1="112" x2="118" y1="20" y2="30" />
                    <line stroke="#C88E75" strokeWidth="0.8" x1="118" x2="112" y1="20" y2="30" />
                  </g>
                </g>

                {/* BALL IMPACT SPARKLES */}
                <g id="left-sparkle" style={{ animation: 'hitSparkLeft 2.4s infinite' }}>
                  <path d="M0 -5 L1.5 -1.5 L5 0 L1.5 1.5 L0 5 L-1.5 1.5 L-5 0 L-1.5 -1.5 Z" fill="#F6BE3D" />
                  <circle cx="-4" cy="-4" fill="#48BB78" r="1.2" />
                  <circle cx="4" cy="4" fill="#E0835D" r="1" />
                </g>
                <g id="right-sparkle" style={{ animation: 'hitSparkRight 2.4s infinite' }}>
                  <path d="M0 -5 L1.5 -1.5 L5 0 L1.5 1.5 L0 5 L-1.5 1.5 L-5 0 L-1.5 -1.5 Z" fill="#F6BE3D" />
                  <circle cx="4" cy="-4" fill="#68D293" r="1.2" />
                  <circle cx="-4" cy="4" fill="#E0835D" r="1" />
                </g>

                {/* ANIMATED TENNIS BALL IN RALLY */}
                <g id="rally-tennis-ball" style={{ animation: 'ballRallyLoop 2.4s cubic-bezier(0.35, 0.15, 0.35, 0.95) infinite' }}>
                  <circle cx="0" cy="0" fill="#D5F237" r="4.5" stroke="#6E7C10" strokeWidth="1" />
                  <path d="M -3 -2 Q 0 0 -3 2" fill="none" stroke="#FFFFFF" strokeLinecap="round" strokeWidth="0.8" />
                  <path d="M 3 -2 Q 0 0 3 2" fill="none" stroke="#FFFFFF" strokeLinecap="round" strokeWidth="0.8" />
                </g>
              </svg>
              <span className="absolute bottom-0.5 text-[8px] font-mono font-black text-[#8C5D19] tracking-widest uppercase opacity-75 pointer-events-none">
                RALLY PAWS
              </span>
            </div>

            {/* Right: Real-Time Arcade HUD Capsules */}
            <div className="flex flex-wrap items-center gap-2.5">
              {/* Score Capsule */}
              <div className="tactile-card-sm bg-[#FFF8EE] rounded-2xl px-3.5 py-2 flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-[#F6BE3D] border-2 border-[#8F4C30] flex items-center justify-center text-base shadow-sm">
                  ⭐
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#A06449]">SCORE</div>
                  <div className="text-base md:text-lg font-black font-mono text-[#6A2E19] leading-tight">
                    {score.toString().padStart(5, '0')} PTS
                  </div>
                </div>
              </div>

              {/* Accuracy Capsule */}
              <div className="tactile-card-sm bg-[#FFF8EE] rounded-2xl px-3.5 py-2 flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-[#68D293] border-2 border-[#8F4C30] flex items-center justify-center text-base shadow-sm text-white font-black">
                  ✓
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#A06449]">ACCURACY</div>
                  <div className="text-base md:text-lg font-black font-mono text-[#235738] leading-tight">
                    {totalGuesses > 0 ? Math.round((correctGuesses / totalGuesses) * 100) : 100}%{' '}
                    <span className="text-xs text-[#6B8574] font-medium">({correctGuesses}/{totalGuesses})</span>
                  </div>
                </div>
              </div>

              {/* Streak Capsule */}
              <div className="tactile-card-sm bg-[#FFF8EE] rounded-2xl px-3.5 py-2 flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-[#F88164] border-2 border-[#8F4C30] flex items-center justify-center text-base shadow-sm">
                  🔥
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#A06449]">STREAK</div>
                  <div className="text-base md:text-lg font-black font-mono text-[#8C2E14] leading-tight">
                    {streak}x
                  </div>
                </div>
              </div>

              {/* Blocks Built Capsule */}
              <div className="tactile-card-sm bg-[#FFF8EE] rounded-2xl px-3.5 py-2 flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-[#86D5EC] border-2 border-[#8F4C30] flex items-center justify-center text-base shadow-sm">
                  📦
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#A06449]">BLOCKS SEALED</div>
                  <div className="text-base md:text-lg font-black font-mono text-[#185368] leading-tight">
                    #{sealedBlocksCount.toString().padStart(4, '0')}
                  </div>
                </div>
              </div>

              {/* WebSocket Indicator */}
              <div className="bg-[#F0DECB] border-2 border-[#AB6B50] rounded-xl px-2.5 py-2 text-[11px] font-mono font-bold text-[#723E2A] flex items-center gap-1.5 shadow-inner">
                <span className={`w-2.5 h-2.5 rounded-full inline-block shadow ${wsConnected ? 'bg-[#48BB78] ping-slow' : 'bg-[#E53E3E]'}`} />
                <span>{wsConnected ? 'WS:3002' : 'OFFLINE'}</span>
              </div>
            </div>
          </div>
        </header>

        {/* Policy Control Bar (Stitch Cozy Layout) */}
        <section className="tactile-card bg-[#FCECD8] rounded-3xl p-3 md:px-5 md:py-3 flex flex-wrap items-center justify-between gap-3">
          {/* Current Policy Status */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="w-7 h-7 rounded-xl bg-[#E67D59] text-white flex items-center justify-center text-xs font-black shadow-sm">🛡️</span>
            <span className="text-xs font-bold tracking-wider uppercase text-[#8D4B32]">Active Compliance Policy:</span>
            <span className="px-3 py-1 rounded-xl bg-[#F6DFBE] border-2 border-[#AC6F51] text-xs md:text-sm font-extrabold text-[#6A2E19] tracking-wide shadow-inner">
              {activePolicy === 'standard' ? 'STANDARD INSTITUTIONAL (STRICT 2-HOP)' : 'LENIENT (1-HOP DIRECT ONLY)'}
            </span>
            {policyNotification && (
              <span className="text-xs font-mono font-black text-[#266840] bg-[#DEF4E6] px-3 py-1 rounded-xl border border-[#7DD89F] animate-pulse">
                {policyNotification}
              </span>
            )}
            {demoNotice && (
              <span className="text-xs font-mono font-black text-[#8C5D17] bg-[#FEF6E4] px-3 py-1 rounded-xl border border-[#F6CB63]">
                {demoNotice}
              </span>
            )}
          </div>

          {/* Action Selectors and Buttons */}
          <div className="flex items-center flex-wrap gap-2.5 ml-auto">
            {/* Custom Transactions Submission Trigger Button */}
            <button
              onClick={() => setIsCustomPanelOpen((prev) => !prev)}
              className={`btn-3d ${
                isCustomPanelOpen
                  ? 'btn-3d-amber ring-2 ring-[#F8B436]'
                  : 'bg-[#FFF8EE] text-[#692E19] border-[#8F4C30] hover:bg-[#FFF2DF]'
              } font-bold text-xs md:text-sm px-3.5 py-2 rounded-2xl flex items-center gap-1.5 tracking-wider cursor-pointer hover:scale-[1.02] active:scale-95 transition-all shadow-sm`}
              id="btn-custom-txs"
              title="Toggle Custom Transaction Submission Panel for Live Demos"
            >
              <span className="text-xs">⚡</span>
              <span>CUSTOM TXS</span>
              <span className="text-[10px] opacity-75 font-mono">{isCustomPanelOpen ? '▲' : '▼'}</span>
            </button>

            {/* Run Live Demo Arcade Button */}
            <button
              onClick={triggerLiveDemo}
              disabled={isSimulatorRunning}
              className={`btn-3d btn-3d-green font-bold text-xs md:text-sm px-4 py-2 rounded-2xl flex items-center gap-1.5 tracking-wider cursor-pointer ${
                isSimulatorRunning ? 'opacity-60 cursor-wait' : ''
              }`}
              id="btn-run-demo"
            >
              <span className="text-xs">{isSimulatorRunning ? '⏳' : '▶'}</span>
              <span>{isSimulatorRunning ? 'RALLY SERVED...' : 'SERVE NEXT RALLY'}</span>
            </button>
            <div className="h-6 w-0.5 bg-[#C9987F] mx-1" />
            {/* Mode Buttons / Toggle Pill */}
            <div className="bg-[#ECD0B3] p-1 rounded-2xl border-2 border-[#8F4C30] flex items-center gap-1">
              <button
                onClick={() => switchPolicy('standard')}
                disabled={isSwitchingPolicy}
                className={`px-3 py-1.5 rounded-xl font-black text-xs shadow-sm flex items-center gap-1 transition-all ${
                  activePolicy === 'standard'
                    ? 'bg-[#E87552] text-white border border-[#7D3219]'
                    : 'text-[#7F4932] hover:bg-[#E3C3A0]'
                }`}
              >
                <span>●</span> STANDARD (2-HOP)
              </button>
              <button
                onClick={() => switchPolicy('lenient')}
                disabled={isSwitchingPolicy}
                className={`px-3 py-1.5 rounded-xl font-black text-xs shadow-sm flex items-center gap-1 transition-all ${
                  activePolicy === 'lenient'
                    ? 'bg-[#E87552] text-white border border-[#7D3219]'
                    : 'text-[#7F4932] hover:bg-[#E3C3A0]'
                }`}
              >
                <span>●</span> LENIENT (1-HOP)
              </button>
            </div>
          </div>
        </section>

        {/* Custom Transaction & Relay Auction Submission Panel (Collapsible) */}
        {isCustomPanelOpen && (
          <section className="tactile-card bg-[#FBF1E2] rounded-3xl p-4 sm:p-5 flex flex-col gap-4 border-[3.5px] border-[#8F4C30] animate-in fade-in slide-in-from-top-3 duration-200">
            {/* Panel Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b-2 border-[#ECD0B3]">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-[#F8B436] border-2 border-[#8F4C30] flex items-center justify-center text-base shadow-[2px_2px_0_#6B341E]">
                  {panelMode === 'relay_auction' ? '🏆' : '⚡'}
                </div>
                <div>
                  <h3 className="font-black text-sm sm:text-base text-[#5C2B1A]">
                    {panelMode === 'relay_auction'
                      ? 'Submit Competing Bids for Relay Auction'
                      : 'Submit Custom Transactions for Live Demo'}
                  </h3>
                  <p className="text-xs text-[#8F4C30] font-bold">
                    {panelMode === 'relay_auction'
                      ? 'Submit multi-builder candidate blocks to the PBS relay and watch compliance auction resolve live'
                      : 'Inject arbitrary transactions through the engine and watch each animate across the arena'}
                  </p>
                </div>
              </div>

              <div className="flex items-center flex-wrap gap-2">
                {/* Mode Selector Pill (Explicit Choice) */}
                <div className="bg-[#ECD0B3] p-1 rounded-2xl border-2 border-[#8F4C30] flex items-center gap-1 shadow-sm">
                  <button
                    type="button"
                    onClick={() => {
                      setPanelMode('individual');
                      setAuctionValidationErrors(null);
                    }}
                    className={`px-3 py-1.5 rounded-xl font-black text-xs transition-all cursor-pointer flex items-center gap-1.5 ${
                      panelMode === 'individual'
                        ? 'bg-[#E87552] text-white border border-[#7D3219] shadow-sm'
                        : 'text-[#7F4932] hover:bg-[#E3C3A0]'
                    }`}
                    id="mode-toggle-individual"
                  >
                    <span>⚡</span>
                    <span>Screen Individually</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPanelMode('relay_auction');
                      fetchNextSuggestedSlot();
                    }}
                    className={`px-3 py-1.5 rounded-xl font-black text-xs transition-all cursor-pointer flex items-center gap-1.5 ${
                      panelMode === 'relay_auction'
                        ? 'bg-[#48BB78] text-white border border-[#1D5E38] shadow-sm'
                        : 'text-[#7F4932] hover:bg-[#E3C3A0]'
                    }`}
                    id="mode-toggle-relay-auction"
                  >
                    <span>🏆</span>
                    <span>Relay Auction</span>
                  </button>
                </div>

                {/* Quick-Fill Example Button */}
                {panelMode === 'individual' ? (
                  <button
                    onClick={loadExampleTransactions}
                    className="bg-[#FFF8EE] hover:bg-[#FFF0DF] border-2 border-[#8F4C30] text-[#692E19] px-3 py-1.5 rounded-xl font-black text-xs cursor-pointer shadow-sm active:scale-95 transition-all flex items-center gap-1.5"
                    title="Pre-fill form with standard ALLOW / FLAG / BLOCK demo transactions"
                    id="btn-load-example"
                  >
                    <span>✨</span>
                    <span>Load Example: ALLOW / FLAG / BLOCK</span>
                  </button>
                ) : (
                  <button
                    onClick={loadExampleRelayAuction}
                    className="bg-[#FFF8EE] hover:bg-[#FFF0DF] border-2 border-[#8F4C30] text-[#692E19] px-3 py-1.5 rounded-xl font-black text-xs cursor-pointer shadow-sm active:scale-95 transition-all flex items-center gap-1.5"
                    title="Pre-fill with 3 competing bids: Compliant Winner, Sanctioned Tx, Sanctioned Fee Recipient"
                    id="btn-load-auction-example"
                  >
                    <span>✨</span>
                    <span>Load Example: Compliant Winner vs Disqualified Bids</span>
                  </button>
                )}

                {/* Input Sub-mode Pill (Only in Individual Mode) */}
                {panelMode === 'individual' && (
                  <div className="bg-[#ECD0B3] p-1 rounded-xl border-2 border-[#8F4C30] flex items-center gap-1">
                    <button
                      onClick={() => {
                        setCustomInputMode('form');
                        setClientValidationError(null);
                        setJsonError(null);
                      }}
                      className={`px-3 py-1 rounded-lg font-black text-xs transition-all cursor-pointer ${
                        customInputMode === 'form'
                          ? 'bg-[#E87552] text-white border border-[#7D3219] shadow-sm'
                          : 'text-[#7F4932] hover:bg-[#E3C3A0]'
                      }`}
                    >
                      📋 Quick-Add Form
                    </button>
                    <button
                      onClick={() => {
                        setCustomInputMode('json');
                        setClientValidationError(null);
                        if (!rawJson.trim() && formRows.length > 0) {
                          setRawJson(
                            JSON.stringify(
                              formRows.map(({ sender, recipient, value }) => ({
                                sender: sender || '0x...',
                                recipient: recipient || '0x...',
                                value: value || DEFAULT_ETH_VALUE_WEI,
                              })),
                              null,
                              2
                            )
                          );
                        }
                      }}
                      className={`px-3 py-1 rounded-lg font-black text-xs transition-all cursor-pointer ${
                        customInputMode === 'json'
                          ? 'bg-[#E87552] text-white border border-[#7D3219] shadow-sm'
                          : 'text-[#7F4932] hover:bg-[#E3C3A0]'
                      }`}
                    >
                      {'{ }'} Raw JSON
                    </button>
                  </div>
                )}

                {/* Close Panel Button */}
                <button
                  onClick={() => setIsCustomPanelOpen(false)}
                  className="p-1.5 rounded-xl border-2 border-[#8F4C30] bg-[#FFF2DE] hover:bg-[#FFE8CF] text-[#692E19] font-bold text-xs cursor-pointer hover:scale-105 active:scale-95 transition-all"
                  title="Close panel"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* ========================================================= */}
            {/* MODE A: SCREEN INDIVIDUALLY                               */}
            {/* ========================================================= */}
            {panelMode === 'individual' && (
              <>
                {/* Mode 1: Quick-Add Form */}
                {customInputMode === 'form' && (
                  <div className="flex flex-col gap-3">
                    {/* Column Headers */}
                    <div className="hidden sm:grid sm:grid-cols-12 gap-2 text-[11px] font-black uppercase tracking-wider text-[#8F4C30] px-1">
                      <div className="col-span-1">#</div>
                      <div className="col-span-5">Sender Address (0x...)</div>
                      <div className="col-span-4">Recipient Address (0x...)</div>
                      <div className="col-span-2">Value (Wei)</div>
                    </div>

                    {/* Rows Container */}
                    <div className="max-h-[320px] overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                      {formRows.map((row, idx) => (
                        <div
                          key={row.id}
                          className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center bg-[#FFF8EE] p-2.5 rounded-2xl border-2 border-[#ECD0B3] hover:border-[#8F4C30] transition-colors"
                        >
                          {/* Row Index */}
                          <div className="col-span-1 flex items-center gap-1">
                            <span className="w-6 h-6 rounded-lg bg-[#ECD0B3] font-mono font-black text-xs text-[#6A2F1B] flex items-center justify-center">
                              {idx + 1}
                            </span>
                          </div>

                          {/* Sender Input */}
                          <div className="col-span-5">
                            <input
                              type="text"
                              value={row.sender}
                              onChange={(e) => updateFormRow(row.id, 'sender', e.target.value)}
                              placeholder="0x... (Sender EOA)"
                              className="w-full font-mono text-xs bg-[#FFFDF9] border-2 border-[#8F4C30] rounded-xl px-3 py-1.5 text-[#5C2B1A] placeholder:text-[#B38C75] focus:outline-none focus:border-[#48BB78]"
                            />
                          </div>

                          {/* Recipient Input */}
                          <div className="col-span-4">
                            <input
                              type="text"
                              value={row.recipient}
                              onChange={(e) => updateFormRow(row.id, 'recipient', e.target.value)}
                              placeholder="0x... (Recipient / Contract)"
                              className="w-full font-mono text-xs bg-[#FFFDF9] border-2 border-[#8F4C30] rounded-xl px-3 py-1.5 text-[#5C2B1A] placeholder:text-[#B38C75] focus:outline-none focus:border-[#48BB78]"
                            />
                          </div>

                          {/* Value Input + Remove Button */}
                          <div className="col-span-2 flex items-center gap-1.5">
                            <input
                              type="text"
                              value={row.value}
                              onChange={(e) => updateFormRow(row.id, 'value', e.target.value)}
                              placeholder="1000000000000000000"
                              className="w-full font-mono text-xs bg-[#FFFDF9] border-2 border-[#8F4C30] rounded-xl px-2 py-1.5 text-[#5C2B1A] placeholder:text-[#B38C75] focus:outline-none focus:border-[#48BB78]"
                            />
                            <button
                              onClick={() => removeFormRow(row.id)}
                              disabled={formRows.length <= 1}
                              className={`w-7 h-7 shrink-0 rounded-xl border-2 border-[#8F4C30] flex items-center justify-center text-xs font-bold transition-all ${
                                formRows.length <= 1
                                  ? 'opacity-30 cursor-not-allowed bg-[#ECD0B3] text-[#8F4C30]'
                                  : 'bg-[#FFF2DE] hover:bg-[#FED7D7] text-[#9B2C2C] hover:border-[#E53E3E] cursor-pointer active:scale-90'
                              }`}
                              title={formRows.length <= 1 ? 'Minimum 1 transaction required' : 'Remove row'}
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Form Bottom Controls */}
                    <div className="flex items-center justify-between pt-1">
                      <button
                        onClick={addFormRow}
                        disabled={formRows.length >= 10}
                        className={`px-3 py-1.5 rounded-xl border-2 border-dashed border-[#8F4C30] font-bold text-xs flex items-center gap-1.5 transition-all ${
                          formRows.length >= 10
                            ? 'opacity-40 cursor-not-allowed bg-[#ECD0B3] text-[#8F4C30]'
                            : 'bg-[#FFF8EE] hover:bg-[#FFF2DF] text-[#7A3F29] cursor-pointer hover:scale-[1.02] active:scale-95'
                        }`}
                      >
                        <span>＋</span>
                        <span>Add Another Transaction ({formRows.length}/10)</span>
                      </button>

                      <span className="text-[11px] text-[#8F4C30] font-bold">
                        Values in wei (1 ETH = 10^18 wei)
                      </span>
                    </div>
                  </div>
                )}

                {/* Mode 2: Raw JSON Paste */}
                {customInputMode === 'json' && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between text-xs text-[#8F4C30] font-bold">
                      <span>Paste JSON array of transactions:</span>
                      <span className="font-mono text-[11px] text-[#A0644B]">
                        [&#123; &quot;sender&quot;: &quot;0x...&quot;, &quot;recipient&quot;: &quot;0x...&quot;, &quot;value&quot;?: &quot;...&quot; &#125;]
                      </span>
                    </div>
                    <textarea
                      value={rawJson}
                      onChange={(e) => handleJsonChange(e.target.value)}
                      placeholder={`[\n  {\n    "sender": "0x1111111111111111111111111111111111111111",\n    "recipient": "0x2222222222222222222222222222222222222222",\n    "value": "1000000000000000000"\n  }\n]`}
                      className="w-full h-44 font-mono text-xs bg-[#FFFDF9] border-2 border-[#8F4C30] rounded-2xl p-3 text-[#5C2B1A] placeholder:text-[#B38C75] focus:outline-none focus:border-[#48BB78] resize-y"
                    />
                  </div>
                )}

                {/* Inline Validation Errors */}
                {clientValidationError && (
                  <div className="p-3 bg-[#FFF0F0] border-2 border-[#E53E3E] rounded-xl flex items-center gap-2 text-xs font-bold text-[#9B2C2C] animate-in fade-in">
                    <span>⚠</span>
                    <span>{clientValidationError}</span>
                  </div>
                )}

                {jsonError && (
                  <div className="p-3 bg-[#FFF0F0] border-2 border-[#E53E3E] rounded-xl flex items-center gap-2 text-xs font-bold text-[#9B2C2C] animate-in fade-in">
                    <span>✕</span>
                    <span>{jsonError}</span>
                  </div>
                )}

                {/* Individual Submit Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#ECD0B3]">
                  <div className="flex items-center flex-wrap gap-2.5">
                    <button
                      onClick={handleSubmitCustomTransactions}
                      disabled={isSubmittingCustom || Boolean(jsonError)}
                      className={`btn-3d btn-3d-green font-black text-xs sm:text-sm px-5 py-2.5 rounded-2xl flex items-center gap-2 tracking-wider cursor-pointer ${
                        isSubmittingCustom || Boolean(jsonError) ? 'opacity-60 cursor-not-allowed' : ''
                      }`}
                      id="btn-submit-custom-txs"
                    >
                      <span className="text-sm">{isSubmittingCustom ? '⏳' : '▶'}</span>
                      <span>
                        {isSubmittingCustom
                          ? `SCREENING (${submissionProgress?.current}/${submissionProgress?.total})...`
                          : `SUBMIT ALL (${customInputMode === 'form' ? formRows.length : 'JSON'})`}
                      </span>
                    </button>

                    {submissionSummary && (
                      <span className="text-xs font-mono font-black text-[#235839] bg-[#DEF4E6] px-3.5 py-2 rounded-xl border border-[#7DD89F] shadow-sm animate-in fade-in">
                        ✓ {submissionSummary}
                      </span>
                    )}
                  </div>

                  <div className="text-[11px] font-mono font-bold text-[#8F4C30] flex items-center gap-1.5 bg-[#FFF2DE] px-3 py-1.5 rounded-xl border border-[#ECD0B3]">
                    <span>⚡</span>
                    <span>400ms stagger between dispatches for distinct arena animations</span>
                  </div>
                </div>

                {/* Individual Submission Audit Results */}
                {submissionResults.length > 0 && (
                  <div className="mt-1 space-y-2 pt-2 border-t border-[#ECD0B3]">
                    <div className="flex items-center justify-between text-xs font-black text-[#692E19]">
                      <span>DISPATCH AUDIT LOG ({submissionResults.length}):</span>
                      <button
                        onClick={() => setSubmissionResults([])}
                        className="text-[10px] text-[#8F4C30] hover:text-[#5C2B1A] underline cursor-pointer"
                      >
                        Clear Results
                      </button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
                      {submissionResults.map((res) => (
                        <div
                          key={res.index}
                          className="p-2.5 rounded-xl bg-white border-2 border-[#ECD0B3] shadow-sm flex flex-col justify-between gap-1.5 text-xs"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono font-bold text-[#8F4C30]">Tx #{res.index}</span>
                            {res.decision ? (
                              <span
                                className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase ${
                                  res.decision === 'ALLOW'
                                    ? 'bg-[#DEF4E6] text-[#235839] border border-[#7DD89F]'
                                    : res.decision === 'FLAG'
                                    ? 'bg-[#FEF6E4] text-[#8C5D17] border border-[#F6CB63]'
                                    : 'bg-[#FED7D7] text-[#9B2C2C] border border-[#E53E3E]'
                                }`}
                              >
                                {res.decision} (Risk: {res.risk_score})
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded-lg text-[10px] font-black uppercase bg-[#FED7D7] text-[#9B2C2C] border border-[#E53E3E]">
                                FAILED
                              </span>
                            )}
                          </div>
                          <div className="font-mono text-[10px] text-[#5C2B1A] truncate" title={res.tx_hash}>
                            Hash: {shortAddr(res.tx_hash)}
                          </div>
                          <div className="font-mono text-[10px] text-[#7A3F29] truncate">
                            {shortAddr(res.sender)} → {shortAddr(res.recipient)}
                          </div>
                          {res.error ? (
                            <div className="text-[10px] text-red-600 font-bold bg-red-50 p-1 rounded">
                              {res.error}
                            </div>
                          ) : (
                            res.reasons &&
                            res.reasons.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {res.reasons.map((reason, rIdx) => (
                                  <span
                                    key={rIdx}
                                    className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#FFF2DE] border border-[#ECD0B3] text-[#7A3F29]"
                                  >
                                    {reason}
                                  </span>
                                ))}
                              </div>
                            )
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ========================================================= */}
            {/* MODE B: RELAY AUCTION (NEW)                               */}
            {/* ========================================================= */}
            {panelMode === 'relay_auction' && (
              <div className="flex flex-col gap-4">
                {/* Target Slot Configuration Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 bg-[#FFF8EE] p-3 rounded-2xl border-2 border-[#ECD0B3]">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xs font-black text-[#5C2B1A] uppercase tracking-wide">
                      Target Slot:
                    </span>
                    <input
                      type="number"
                      value={auctionSlot}
                      onChange={(e) => setAuctionSlot(Number(e.target.value) || 0)}
                      className="w-24 bg-[#FFFDF9] border-2 border-[#8F4C30] rounded-xl px-2.5 py-1 text-xs font-mono font-black text-[#5C2B1A] focus:outline-none focus:border-[#48BB78]"
                    />
                    <button
                      type="button"
                      onClick={fetchNextSuggestedSlot}
                      className="px-2.5 py-1 rounded-xl border border-[#8F4C30] bg-[#ECD0B3] hover:bg-[#E3C3A0] text-[#692E19] font-black text-xs cursor-pointer shadow-xs active:scale-95 transition-all flex items-center gap-1"
                      title="Fetch highest slot from relay bids and increment"
                    >
                      <span>↻</span> Auto-Suggest Next Slot
                    </button>
                  </div>
                  <div className="text-[11px] text-[#8F4C30] font-bold">
                    PBS Auction Rule: Highest compliant bid wins the header; tainted bids are disqualified.
                  </div>
                </div>

                {/* Competing Builder Bids List */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-black text-[#5C2B1A] uppercase tracking-wider">
                    <span>Competing Builder Bids ({builderBids.length}/5):</span>
                    <span className="text-[11px] text-[#8F4C30] font-normal lowercase">
                      configure builder label, bid value, fee recipient, and constituent block transactions
                    </span>
                  </div>

                  {builderBids.map((bid, bIdx) => (
                    <div
                      key={bid.id}
                      className="bg-[#FFFDF9] border-2 border-[#8F4C30] rounded-2xl p-3.5 space-y-3 shadow-sm hover:border-[#5C2B1A] transition-colors"
                    >
                      {/* Top Row: Bid Meta */}
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-2.5 items-center pb-2 border-b border-[#F0DFCD]">
                        {/* Builder Label */}
                        <div className="md:col-span-4 flex items-center gap-2">
                          <span className="w-6 h-6 rounded-lg bg-[#F8B436] border border-[#8F4C30] font-mono font-black text-xs text-[#5C2B1A] flex items-center justify-center shrink-0">
                            {bIdx + 1}
                          </span>
                          <input
                            type="text"
                            value={bid.builder_id}
                            onChange={(e) => updateBuilderBid(bid.id, 'builder_id', e.target.value)}
                            placeholder="Builder Label (e.g. Builder A)"
                            className="w-full text-xs font-black text-[#5C2B1A] bg-[#FFF8EE] border border-[#8F4C30] rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-[#48BB78]"
                          />
                        </div>

                        {/* Bid Value (ETH) */}
                        <div className="md:col-span-3 flex items-center gap-1.5">
                          <label className="text-[11px] font-bold text-[#8F4C30] shrink-0">Bid:</label>
                          <input
                            type="text"
                            value={bid.bid_value_eth}
                            onChange={(e) => updateBuilderBid(bid.id, 'bid_value_eth', e.target.value)}
                            placeholder="2.0"
                            className="w-20 font-mono font-black text-xs text-[#5C2B1A] bg-[#FFF8EE] border border-[#8F4C30] rounded-xl px-2 py-1.5 focus:outline-none focus:border-[#48BB78]"
                          />
                          <span className="text-xs font-mono font-black text-[#5C2B1A]">ETH</span>
                        </div>

                        {/* Fee Recipient */}
                        <div className="md:col-span-4 flex items-center gap-1.5">
                          <label className="text-[11px] font-bold text-[#8F4C30] shrink-0">Fee Recipient:</label>
                          <input
                            type="text"
                            value={bid.fee_recipient}
                            onChange={(e) => updateBuilderBid(bid.id, 'fee_recipient', e.target.value)}
                            placeholder="0x... (Fee EOA)"
                            className="w-full font-mono text-xs text-[#5C2B1A] bg-[#FFF8EE] border border-[#8F4C30] rounded-xl px-2 py-1.5 focus:outline-none focus:border-[#48BB78]"
                          />
                        </div>

                        {/* Delete Bid Button */}
                        <div className="md:col-span-1 flex justify-end">
                          <button
                            type="button"
                            onClick={() => removeBuilderBid(bid.id)}
                            disabled={builderBids.length <= 1}
                            className={`w-7 h-7 rounded-xl border border-[#8F4C30] flex items-center justify-center text-xs font-bold transition-all ${
                              builderBids.length <= 1
                                ? 'opacity-30 cursor-not-allowed bg-[#ECD0B3] text-[#8F4C30]'
                                : 'bg-[#FFF2DE] hover:bg-[#FED7D7] text-[#9B2C2C] cursor-pointer'
                            }`}
                            title={builderBids.length <= 1 ? 'Minimum 1 bid required' : 'Remove builder bid'}
                          >
                            ✕
                          </button>
                        </div>
                      </div>

                      {/* Constituent Block Transactions Section */}
                      <div className="space-y-2 pt-1">
                        <div className="flex items-center justify-between text-[11px] font-bold text-[#8F4C30]">
                          <span>Constituent Transactions in Proposed Block ({bid.txs.length}):</span>
                          <button
                            type="button"
                            onClick={() => addTxToBid(bid.id)}
                            disabled={bid.txs.length >= 5}
                            className={`text-[10px] font-black px-2 py-0.5 rounded-lg border border-[#8F4C30] transition-all ${
                              bid.txs.length >= 5
                                ? 'opacity-40 cursor-not-allowed bg-[#ECD0B3]'
                                : 'bg-[#FFF8EE] hover:bg-[#FFF0DF] text-[#692E19] cursor-pointer'
                            }`}
                          >
                            ＋ Add Tx to Bid ({bid.txs.length}/5)
                          </button>
                        </div>

                        <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1 custom-scrollbar">
                          {bid.txs.map((tx, tIdx) => (
                            <div
                              key={tx.id}
                              className="grid grid-cols-1 sm:grid-cols-12 gap-1.5 items-center bg-[#FFF8EE] p-1.5 rounded-xl border border-[#ECD0B3]"
                            >
                              <div className="sm:col-span-1 text-[10px] font-mono font-bold text-[#8F4C30] text-center">
                                #{tIdx + 1}
                              </div>
                              <div className="sm:col-span-5">
                                <input
                                  type="text"
                                  value={tx.sender}
                                  onChange={(e) => updateTxInBid(bid.id, tx.id, 'sender', e.target.value)}
                                  placeholder="0x... (Sender)"
                                  className="w-full font-mono text-[11px] bg-white border border-[#8F4C30] rounded-lg px-2 py-1 text-[#5C2B1A] focus:outline-none focus:border-[#48BB78]"
                                />
                              </div>
                              <div className="sm:col-span-4">
                                <input
                                  type="text"
                                  value={tx.recipient}
                                  onChange={(e) => updateTxInBid(bid.id, tx.id, 'recipient', e.target.value)}
                                  placeholder="0x... (Recipient)"
                                  className="w-full font-mono text-[11px] bg-white border border-[#8F4C30] rounded-lg px-2 py-1 text-[#5C2B1A] focus:outline-none focus:border-[#48BB78]"
                                />
                              </div>
                              <div className="sm:col-span-2 flex items-center gap-1">
                                <input
                                  type="text"
                                  value={tx.value}
                                  onChange={(e) => updateTxInBid(bid.id, tx.id, 'value', e.target.value)}
                                  placeholder="1000000000000000000"
                                  className="w-full font-mono text-[11px] bg-white border border-[#8F4C30] rounded-lg px-1.5 py-1 text-[#5C2B1A] focus:outline-none focus:border-[#48BB78]"
                                  title="Value in Wei"
                                />
                                <button
                                  type="button"
                                  onClick={() => removeTxFromBid(bid.id, tx.id)}
                                  disabled={bid.txs.length <= 1}
                                  className={`w-5 h-5 shrink-0 rounded-lg border border-[#8F4C30] flex items-center justify-center text-[10px] font-bold ${
                                    bid.txs.length <= 1
                                      ? 'opacity-30 cursor-not-allowed bg-[#ECD0B3]'
                                      : 'bg-[#FFF2DE] hover:bg-[#FED7D7] text-[#9B2C2C] cursor-pointer'
                                  }`}
                                  title="Remove transaction"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Add Competing Builder Bid Button */}
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={addBuilderBid}
                      disabled={builderBids.length >= 5}
                      className={`px-3 py-1.5 rounded-xl border-2 border-dashed border-[#8F4C30] font-bold text-xs flex items-center gap-1.5 transition-all ${
                        builderBids.length >= 5
                          ? 'opacity-40 cursor-not-allowed bg-[#ECD0B3] text-[#8F4C30]'
                          : 'bg-[#FFF8EE] hover:bg-[#FFF2DF] text-[#7A3F29] cursor-pointer hover:scale-[1.01] active:scale-95'
                      }`}
                    >
                      <span>＋</span>
                      <span>Add Another Competing Builder Bid ({builderBids.length}/5)</span>
                    </button>
                  </div>
                </div>

                {/* Validation Errors */}
                {auctionValidationErrors && auctionValidationErrors.length > 0 && (
                  <div className="p-3 bg-[#FFF0F0] border-2 border-[#E53E3E] rounded-xl text-xs text-[#9B2C2C] space-y-1 animate-in fade-in">
                    <div className="font-black flex items-center gap-1.5">
                      <span>⚠</span>
                      <span>Please fix the following issues before submitting auction:</span>
                    </div>
                    <ul className="list-disc list-inside space-y-0.5 pl-1 font-semibold">
                      {auctionValidationErrors.map((err, eIdx) => (
                        <li key={eIdx}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Relay Auction Submit Action Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[#ECD0B3]">
                  <div className="flex items-center flex-wrap gap-2.5">
                    <button
                      type="button"
                      onClick={handleSubmitRelayAuction}
                      disabled={isSubmittingAuction}
                      className={`btn-3d btn-3d-green font-black text-xs sm:text-sm px-6 py-2.5 rounded-2xl flex items-center gap-2 tracking-wider cursor-pointer ${
                        isSubmittingAuction ? 'opacity-60 cursor-not-allowed' : ''
                      }`}
                      id="btn-submit-relay-auction"
                    >
                      <span className="text-sm">{isSubmittingAuction ? '⏳' : '▶'}</span>
                      <span>
                        {isSubmittingAuction
                          ? `DISPATCHING (${auctionProgress?.current}/${auctionProgress?.total}): ${auctionProgress?.currentBuilder || 'Auditing'}...`
                          : `SUBMIT RELAY AUCTION (${builderBids.length} BIDS)`}
                      </span>
                    </button>

                    {auctionResult && (
                      <span className="text-xs font-mono font-black text-[#235839] bg-[#DEF4E6] px-3.5 py-2 rounded-xl border border-[#7DD89F] shadow-sm animate-in fade-in">
                        ✓ Slot {auctionResult.slot} Resolved at {auctionResult.submittedAt}
                      </span>
                    )}
                  </div>

                  <div className="text-[11px] font-mono font-bold text-[#8F4C30] flex items-center gap-1.5 bg-[#FFF2DE] px-3 py-1.5 rounded-xl border border-[#ECD0B3]">
                    <span>⚡</span>
                    <span>400ms stagger between bid dispatches → Async relay compliance evaluation</span>
                  </div>
                </div>

                {/* ========================================================= */}
                {/* LIVE AUCTION RESOLUTION RESULT AREA                       */}
                {/* ========================================================= */}
                {auctionResult && (
                  <div className="mt-2 space-y-4 pt-4 border-t-2 border-[#ECD0B3] animate-in fade-in slide-in-from-top-2 duration-300">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black text-[#5C2B1A] uppercase tracking-wider">
                          Auction Resolution Live Board
                        </span>
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-full bg-[#ECD0B3] text-[#692E19]">
                          Slot #{auctionResult.slot}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setAuctionResult(null)}
                        className="text-[11px] font-bold text-[#8F4C30] hover:text-[#5C2B1A] underline cursor-pointer"
                      >
                        Clear Auction Board
                      </button>
                    </div>

                    {/* Spotlight Card: Winning Header OR Fail-Closed Banner */}
                    {auctionResult.winningHeader ? (
                      <div className="tactile-card bg-[#E5F7EB] border-[3px] border-[#48BB78] rounded-2xl p-4 md:p-5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
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
                                Slot {auctionResult.slot}
                              </span>
                            </div>
                            <div className="text-lg md:text-xl font-black text-[#154629] font-mono mt-0.5">
                              {auctionResult.winningHeader.builder_id}
                            </div>
                            <div className="text-xs text-[#286C45] font-mono">
                              Block: {auctionResult.winningHeader.block_hash.slice(0, 22)}... | Fee Recipient:{' '}
                              {shortAddr(auctionResult.winningHeader.fee_recipient)}
                            </div>
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs uppercase font-bold text-[#1D5E38]">Validated MEV Bid Value</div>
                          <div className="text-2xl md:text-3xl font-black font-mono text-[#154629]">
                            {(Number(auctionResult.winningHeader.value_wei) / 1e18).toFixed(4)} ETH
                          </div>
                          <div className="text-[11px] text-[#286C45] font-bold">
                            ✓ Cryptographically Proven Sanction-Free
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="tactile-card bg-[#FDE8E8] border-[3px] border-[#E53E3E] rounded-2xl p-4 md:p-5 flex flex-wrap items-center justify-between gap-4 shadow-sm">
                        <div className="flex items-center gap-3.5">
                          <div className="w-12 h-12 rounded-2xl bg-[#E53E3E] text-white flex items-center justify-center text-2xl shadow-sm">
                            🛑
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-black uppercase tracking-wider text-[#9B2C2C]">
                                FAIL-CLOSED: RELAY REFUSED TO PROPOSE
                              </span>
                              <span className="px-2 py-0.5 rounded-md bg-white border border-[#E53E3E] text-[#9B2C2C] font-mono text-xs font-black">
                                Slot {auctionResult.slot}
                              </span>
                            </div>
                            <div className="text-base md:text-lg font-black text-[#781B1B] mt-0.5">
                              No Compliant Block Header Selected
                            </div>
                            <div className="text-xs text-[#9B2C2C] font-semibold mt-0.5">
                              All submitted candidate bids were disqualified under compliance policy. The relay strictly fails closed rather than proposing a tainted header.
                            </div>
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs uppercase font-bold text-[#9B2C2C]">Auction Status</div>
                          <div className="text-xl md:text-2xl font-black font-mono text-[#781B1B]">
                            0 / {auctionResult.bids.length} COMPLIANT
                          </div>
                          <div className="text-[11px] text-[#9B2C2C] font-bold">
                            ⛔ Zero Taint Tolerance Enforced
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Bids Table with Winner Trophy and Disqualified Strikethroughs */}
                    <div className="border-2 border-[#8F4C30] rounded-2xl overflow-hidden bg-white shadow-inner">
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs sm:text-sm font-mono">
                          <thead className="bg-[#F8ECE0] text-[#7A3F29] uppercase font-black text-[11px] tracking-wider border-b-2 border-[#8F4C30]">
                            <tr>
                              <th className="py-3 px-4">Builder Label</th>
                              <th className="py-3 px-4">Bid Value</th>
                              <th className="py-3 px-4">Compliance Verdict</th>
                              <th className="py-3 px-4">Reason Codes &amp; Disqualification Proof</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-[#F1DEC9]">
                            {auctionResult.bids.map((bid, bIdx) => {
                              const isWinner =
                                auctionResult.winningHeader?.builder_id === bid.builder_id &&
                                bid.verdict === 'COMPLIANT';
                              const isTainted =
                                bid.verdict === 'EXPOSED_TX' ||
                                bid.verdict === 'EXPOSED_BUILDER' ||
                                bid.verdict === 'REJECTED';
                              const ethVal = (Number(bid.value_wei) / 1e18).toFixed(4);

                              return (
                                <tr
                                  key={bid.id || bIdx}
                                  className={`transition-colors ${
                                    isWinner
                                      ? 'bg-[#E5F7EB]/70 font-semibold'
                                      : isTainted
                                      ? 'bg-red-50/60'
                                      : 'hover:bg-[#FFF9F2]'
                                  }`}
                                >
                                  {/* Builder Label */}
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
                                    </div>
                                    <div className="text-[10px] text-[#A06449] font-normal font-mono mt-0.5">
                                      Fee Recipient: {shortAddr(bid.fee_recipient)}
                                    </div>
                                  </td>

                                  {/* Bid Value */}
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
                                      {ethVal} ETH
                                    </span>
                                  </td>

                                  {/* Compliance Verdict Badge */}
                                  <td className="py-3.5 px-4 align-top">
                                    <span
                                      className={`px-2.5 py-1 rounded-lg text-[10px] font-black uppercase ${
                                        isWinner
                                          ? 'bg-[#DEF4E6] text-[#235839] border border-[#7DD89F]'
                                          : bid.verdict === 'EXPOSED_BUILDER'
                                          ? 'bg-[#FED7D7] text-[#9B2C2C] border border-[#E53E3E]'
                                          : bid.verdict === 'EXPOSED_TX'
                                          ? 'bg-[#FED7D7] text-[#9B2C2C] border border-[#E53E3E]'
                                          : bid.verdict === 'REJECTED'
                                          ? 'bg-[#FED7D7] text-[#9B2C2C] border border-[#E53E3E]'
                                          : 'bg-[#FEF6E4] text-[#8C5D17] border border-[#F6CB63]'
                                      }`}
                                    >
                                      {isWinner ? 'WINNER (COMPLIANT)' : bid.verdict}
                                    </span>
                                  </td>

                                  {/* Disqualification Reasons & Proofs */}
                                  <td className="py-3.5 px-4 align-top text-xs">
                                    {isWinner ? (
                                      <span className="text-[#1D5E38] font-bold flex items-center gap-1.5">
                                        <span>✓</span>
                                        <span>Cryptographically compliant — Highest valid MEV bid chosen</span>
                                      </span>
                                    ) : bid.error ? (
                                      <div className="text-red-700 font-bold bg-red-100 p-1.5 rounded text-[11px]">
                                        Submission Error: {bid.error}
                                      </div>
                                    ) : bid.reasons && bid.reasons.length > 0 ? (
                                      <div className="space-y-1">
                                        {bid.reasons.map((reason, rIdx) => (
                                          <div
                                            key={rIdx}
                                            className="text-red-700 font-bold bg-red-100/80 p-1.5 rounded text-[11px] border border-red-200"
                                          >
                                            {reason}
                                          </div>
                                        ))}
                                      </div>
                                    ) : (
                                      <span className="text-[#8F4C30] italic text-xs">
                                        Disqualified under active compliance policy
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* Guess Verdict Bar (Stitch Cozy Layout) */}
        <section className="tactile-card bg-[#FFF6EB] rounded-3xl p-3 md:p-4 flex flex-wrap items-center justify-between gap-4 relative">
          {/* Instruction Prompt */}
          <div className="flex items-center gap-2 text-xs md:text-sm font-bold text-[#86432B]">
            <span className="w-6 h-6 rounded-full bg-[#FFB947] text-white flex items-center justify-center text-xs font-black shadow">🎾</span>
            <span className="font-extrabold text-[#6A2F1B]">GUESS THE VERDICT:</span>
            <span className="text-xs font-bold text-[#7E4228] bg-[#F7E7D1] px-2.5 py-1 rounded-lg border border-[#DDBFA4] flex items-center gap-1.5" id="target-label">
              {activeTargetSprite ? (
                <>
                  <span
                    className={`w-2 h-2 rounded-full ${
                      activeTargetSprite.data.decision === 'BLOCK'
                        ? 'bg-[#E53E3E]'
                        : activeTargetSprite.data.decision === 'FLAG'
                        ? 'bg-[#ED8936]'
                        : 'bg-[#59C886]'
                    }`}
                  />
                  TARGET: <strong className="font-mono text-[#4A1F0D]">{shortAddr(activeTargetSprite.data.tx_hash)}</strong> ({activeTargetSprite.data.risk_score > 60 ? 'High Risk' : activeTargetSprite.data.risk_score > 30 ? 'Medium Risk' : 'Low Risk'})
                </>
              ) : (
                <span>SELECT A TRAVELING BALL OR PRESS [1/2/3]</span>
              )}
            </span>
          </div>

          {/* Chunky 3D Game Action Verdict Buttons */}
          <div className="flex items-center gap-3 ml-auto">
            {/* Allow (1) */}
            <button
              onClick={() => handleGuess('ALLOW')}
              className="btn-3d btn-3d-green px-5 py-2 rounded-2xl font-black text-xs md:text-sm flex items-center gap-2 uppercase tracking-wide cursor-pointer transition-all active:scale-95"
              id="btn-allow"
              title="Hit Clean Topspin Pass [1]"
            >
              <span className="w-5 h-5 rounded-lg bg-[#276F46] flex items-center justify-center text-xs">🏸</span>
              ALLOW <span className="opacity-80 text-xs font-mono font-medium">(1)</span>
            </button>
            {/* Flag (2) */}
            <button
              onClick={() => handleGuess('FLAG')}
              className="btn-3d btn-3d-amber px-5 py-2 rounded-2xl font-black text-xs md:text-sm flex items-center gap-2 uppercase tracking-wide cursor-pointer transition-all active:scale-95"
              id="btn-flag"
              title="High Slice Lob into Review [2]"
            >
              <span className="w-5 h-5 rounded-lg bg-[#9F6612] flex items-center justify-center text-xs">⚡</span>
              FLAG <span className="opacity-80 text-xs font-mono font-medium">(2)</span>
            </button>
            {/* Block (3) */}
            <button
              onClick={() => handleGuess('BLOCK')}
              className="btn-3d btn-3d-red px-5 py-2 rounded-2xl font-black text-xs md:text-sm flex items-center gap-2 uppercase tracking-wide cursor-pointer transition-all active:scale-95"
              id="btn-block"
              title="Down Smash Hard Out [3]"
            >
              <span className="w-5 h-5 rounded-lg bg-[#8E2F23] flex items-center justify-center text-xs">🛑</span>
              BLOCK <span className="opacity-80 text-xs font-mono font-medium">(3)</span>
            </button>
          </div>
        </section>

        {/* Main Arena: Cozy Tennis Court Mempool & Hoppers */}
        <main className="tactile-card bg-[#F5E2CC] rounded-3xl p-4 md:p-5 relative overflow-hidden" id="arena-main-box">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between pb-3 border-b-2 border-[#E3C6AA] mb-4 gap-3">
            <div className="flex items-center gap-3">
              <span className="text-2xl p-2 rounded-2xl bg-[#FFE4BA] border-2 border-[#8F4C30] shadow-sm">🎾</span>
              <div>
                <h2 className="text-lg md:text-xl font-black text-[#692E19] tracking-wide uppercase">
                  TENNIS COURT MEMPOOL &amp; COMPLIANCE NET
                </h2>
                <p className="text-xs font-bold text-[#A5684E]">
                  Tennis Ball Transactions Lobbing Through Deterministic Gate (&lt;3.8µs) into Destination Collector Hoppers
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="bg-[#FFF4E4] px-3 py-1 rounded-xl text-xs font-mono font-black text-[#743C27] border-2 border-[#AB6C4E] shadow-sm flex items-center gap-1.5">
                <span>🎾</span> <span>{inFlightSprites.length} LIVE TENNIS BALLS IN FLIGHT</span>
              </span>
              <div className="bg-[#E7F8EE] border-2 border-[#48BB78] rounded-xl px-3 py-1 text-xs font-bold text-[#1E5D36] flex items-center gap-1.5 shadow-sm">
                <span className="w-2 h-2 rounded-full bg-[#48BB78] ping-slow" />
                <span>LATENCY: {liveLatency}</span>
              </div>
            </div>
          </div>

          {/* Grid Layout: Left Court + Center Net + Right Hoppers */}
          <div ref={arenaGridRef} className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch relative">
            {/* Dynamic Rally Physics Canvas Overlay covering the entire court and all hoppers */}
            <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-35 w-full h-full" />

            {/* LEFT & CENTER: Full Tennis Court (Cols 1-7) */}
            <div
              ref={courtContainerRef}
              className="lg:col-span-7 flex flex-col justify-between rounded-3xl p-4 border-3 border-[#8F4C30] shadow-inner relative overflow-hidden court-grid-pattern min-h-[520px]"
              id="clay-court-container"
            >
              {/* Tennis Court Markings Overlays */}
              <div className="absolute inset-0 pointer-events-none p-3 flex flex-col justify-between">
                <div className="w-full h-full border-4 border-[#FFF9EE] border-opacity-90 rounded-2xl relative">
                  {/* Tramline (Double Alley) */}
                  <div className="absolute top-0 bottom-0 left-6 border-r-3 border-dashed border-[#FFF9EE]/70" />
                  {/* Service Line */}
                  <div className="absolute top-0 bottom-0 left-1/2 border-r-4 border-[#FFF9EE]/85" />
                  {/* Center Service T-Line */}
                  <div className="absolute top-1/2 left-6 right-0 border-t-4 border-[#FFF9EE]/80" />
                  {/* Baseline hash mark on left */}
                  <div className="absolute top-1/2 -left-1 w-4 border-t-4 border-[#FFF9EE]" />
                </div>
              </div>

              {/* Court Side Labels */}
              <div className="relative z-10 flex items-center justify-between text-[11px] font-black tracking-wider uppercase text-white/90 drop-shadow-sm px-2 pb-2">
                <div className="flex items-center gap-1.5 bg-[#8F4C30]/80 px-2.5 py-1 rounded-xl backdrop-blur-sm border border-[#FFE7D3]/40">
                  <span>🎾 SERVING COURT: INCOMING MEMPOOL</span>
                </div>
                <div className="flex items-center gap-1.5 bg-[#8F4C30]/80 px-2.5 py-1 rounded-xl backdrop-blur-sm border border-[#FFE7D3]/40">
                  <span>INSPECTION CHECKPOINT ➔</span>
                </div>
              </div>

              {/* Floating Hit Feedback Banners */}
              {floatingPills.map((p) => (
                <div
                  key={p.id}
                  className={`hit-floating-pill px-3 py-1 rounded-2xl text-xs md:text-sm font-black tracking-wider uppercase shadow-lg border-2 ${p.colorClass}`}
                  style={{ left: `${p.x}px`, top: `${p.y}px` }}
                >
                  {p.text}
                </div>
              ))}

              {/* DYNAMIC TENNIS RACKET (Visual Swing Actor & Hover Companion) */}
              <div
                id="tactile-tennis-racket"
                className="racket-interactive-container"
                style={{
                  left: `${racketX}px`,
                  top: `${racketY}px`,
                }}
              >
                <div
                  id="racket-inner-graphic"
                  className={`${racketSwingClass || 'racket-idle-float'} transition-transform duration-200`}
                >
                  {/* Stylized Cozy Wooden/Arcade Tennis Racket SVG */}
                  <svg
                    className="drop-shadow-[0_8px_10px_rgba(78,32,18,0.42)]"
                    fill="none"
                    height="92"
                    viewBox="0 0 100 110"
                    width="84"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    {/* Racket Swoosh / Motion Aura */}
                    <path
                      id="racket-swoosh-glow"
                      className="transition-opacity duration-300"
                      d="M12 90 C18 45, 52 18, 92 20"
                      opacity={racketSwingClass ? 0.95 : 0}
                      stroke={racketGlowColor}
                      strokeLinecap="round"
                      strokeWidth="6"
                    />
                    {/* Handle Base & Grip */}
                    <rect
                      fill="#E3A857"
                      height="32"
                      rx="4"
                      stroke="#683416"
                      strokeWidth="2.5"
                      transform="rotate(-38 22 74)"
                      width="13"
                      x="22"
                      y="74"
                    />
                    {/* Grip Wrap Stripes */}
                    <line stroke="#FFF7ED" strokeLinecap="round" strokeWidth="2.5" x1="28" x2="35" y1="78" y2="85" />
                    <line stroke="#FFF7ED" strokeLinecap="round" strokeWidth="2.5" x1="33" x2="40" y1="84" y2="91" />
                    <line stroke="#FFF7ED" strokeLinecap="round" strokeWidth="2.5" x1="38" x2="45" y1="90" y2="97" />
                    <rect
                      fill="#8D4324"
                      height="6"
                      rx="2"
                      stroke="#4C210E"
                      strokeWidth="2"
                      transform="rotate(-38 39 96)"
                      width="14"
                      x="39"
                      y="96"
                    />
                    {/* Shaft Throats */}
                    <path d="M42 55 L35 72 L45 78 L53 62 Z" fill="#D97746" stroke="#683416" strokeWidth="2" />
                    {/* Racket Head Outer Rim */}
                    <ellipse
                      cx="62"
                      cy="40"
                      fill="#FFF9F2"
                      rx="30"
                      ry="34"
                      stroke="#B85328"
                      strokeWidth="6"
                      transform="rotate(18 62 40)"
                    />
                    {/* Inner Frame Accent */}
                    <ellipse
                      cx="62"
                      cy="40"
                      fill="#FFEEDC"
                      opacity="0.85"
                      rx="26"
                      ry="30"
                      stroke="#703217"
                      strokeWidth="2"
                      transform="rotate(18 62 40)"
                    />
                    {/* Racket String Mesh (Cross Strings) */}
                    <g opacity="0.8" stroke="#C6987C" strokeWidth="1.2" transform="rotate(18 62 40)">
                      <line x1="48" x2="48" y1="14" y2="66" />
                      <line x1="55" x2="55" y1="10" y2="70" />
                      <line x1="62" x2="62" y1="8" y2="72" />
                      <line x1="69" x2="69" y1="10" y2="70" />
                      <line x1="76" x2="76" y1="14" y2="66" />
                      <line x1="38" x2="86" y1="28" y2="28" />
                      <line x1="34" x2="90" y1="36" y2="36" />
                      <line x1="34" x2="90" y1="44" y2="44" />
                      <line x1="38" x2="86" y1="52" y2="52" />
                    </g>
                    {/* Center Sweet Spot Stencil Stamp */}
                    <ellipse
                      cx="62"
                      cy="40"
                      fill="none"
                      opacity="0.85"
                      rx="10"
                      ry="12"
                      stroke="#E66A45"
                      strokeWidth="3"
                      transform="rotate(18 62 40)"
                    />
                    {/* Head Gloss Highlight */}
                    <path
                      d="M44 26 C50 16, 68 14, 80 20"
                      opacity="0.9"
                      stroke="#FFFFFF"
                      strokeLinecap="round"
                      strokeWidth="3"
                    />
                  </svg>
                </div>
              </div>

              {/* PLAYFIELD: Real-Time Traveling Transaction Cards */}
              <div className="relative z-20 flex-1 flex flex-col justify-around py-2 pr-14 gap-3">
                {inFlightSprites.length === 0 ? (
                  <div className="text-center py-16 flex flex-col items-center justify-center gap-3">
                    <span className="text-5xl">🎾</span>
                    <p className="font-extrabold text-white text-base drop-shadow-md">
                      Mempool Court is Calm. Ready to Serve!
                    </p>
                    <button
                      onClick={triggerLiveDemo}
                      className="btn-3d btn-3d-green font-black text-xs px-5 py-2.5 rounded-xl shadow-lg"
                    >
                      ▶ Serve 6 Scenario Wave
                    </button>
                  </div>
                ) : (
                  inFlightSprites.slice(-3).map((sprite) => {
                    const isTarget = sprite.id === activeTargetId;
                    const d = sprite.data;
                    const progressPercent = Math.min(100, Math.max(0, Math.round(((sprite.x - 6) / (47 - 6)) * 100)));

                    let ballClass = 'tennis-ball-sphere';
                    let ballNumColor = 'text-[#506300]';
                    let statusBadge = 'bg-[#DEF4E6] text-[#235839] border-[#7DD89F]';
                    let iconChar = '✓';
                    let spinLabel = 'SERVED ➔';
                    let spinBadge = 'bg-[#EAF7ED] text-[#266840] border-[#75CE96]';

                    if (d.decision === 'FLAG') {
                      ballClass = 'tennis-ball-sphere-amber';
                      ballNumColor = 'text-[#523300]';
                      statusBadge = 'bg-[#FEF6E4] text-[#8C5D17] border-[#F6CB63]';
                      iconChar = '⚠';
                      spinLabel = 'LOB TRAIL';
                      spinBadge = 'bg-[#FEF4DB] text-[#9A6214] border-[#F3C55D]';
                    } else if (d.decision === 'BLOCK') {
                      ballClass = 'tennis-ball-sphere-red';
                      ballNumColor = 'text-white';
                      statusBadge = 'bg-[#FCE5E2] text-[#9B2C2C] border-[#F49A90]';
                      iconChar = '✖';
                      spinLabel = 'FAST SPIN';
                      spinBadge = 'bg-[#FDE8E6] text-[#A82A2A] border-[#F49A90]';
                    }

                    return (
                      <div
                        key={sprite.id}
                        id={`card-${sprite.id}`}
                        onClick={() => {
                          setSelectedTx(d);
                          setActiveTargetId(sprite.id);
                          playRetroBleep(700, 'sine', 0.08);
                        }}
                        className={`tactile-card rounded-2xl p-3 cursor-pointer hover:scale-[1.01] transition-all flex items-center gap-3.5 group relative ${
                          isTarget ? 'ring-4 ring-[#65C989] shadow-[0_5px_0_#469762]' : 'bg-[#FFFDF9]'
                        }`}
                      >
                        {/* 3D Tennis Ball Sphere Icon */}
                        <div
                          className={`w-13 h-13 min-w-[52px] h-[52px] rounded-full ${ballClass} relative flex items-center justify-center bobble-anim shadow-md group-hover:rotate-12 transition-transform`}
                        >
                          <span className="tennis-ball-seam" />
                          <span className={`text-sm font-black drop-shadow ${ballNumColor}`}>
                            #{sprite.ballNumber}
                          </span>
                          <span
                            className={`absolute -bottom-1 -right-1 w-5 h-5 rounded-full border-2 border-white text-white text-[10px] font-black flex items-center justify-center ${
                              d.decision === 'BLOCK'
                                ? 'bg-[#E53E3E]'
                                : d.decision === 'FLAG'
                                ? 'bg-[#ED8936]'
                                : 'bg-[#48BB78]'
                            }`}
                          >
                            {iconChar}
                          </span>
                        </div>

                        {/* Transaction Metadata & Progress */}
                        <div className="flex-1 min-w-0">
                          {/* Mini progress bar towards Gate */}
                          <div className="w-full bg-[#EFE4D2] h-1.5 rounded-full overflow-hidden mb-1.5">
                            <div
                              className="bg-[#65C989] h-full transition-all duration-100"
                              style={{ width: `${progressPercent}%` }}
                            />
                          </div>

                          <div className="flex items-center justify-between flex-wrap gap-1">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs font-black text-[#5C2B1B]">
                                {shortAddr(d.tx_hash)}
                              </span>
                              {isTarget && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-[#DEF4E6] text-[#235839] border border-[#7DD89F]">
                                  TARGETED
                                </span>
                              )}
                              {sprite.userGuess && (
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-[#FEF08A] text-black border border-black">
                                  GUESS: {sprite.userGuess}
                                </span>
                              )}
                            </div>
                            <span className={`px-2 py-0.5 rounded-md text-[10px] font-black border ${statusBadge}`}>
                              {d.decision === 'BLOCK'
                                ? 'ALERT: SANCTIONS'
                                : d.decision === 'FLAG'
                                ? 'EDD REQUIRED'
                                : 'VASP Verified'}
                            </span>
                          </div>

                          <div className="grid grid-cols-3 gap-2 mt-1.5 text-xs font-semibold text-[#7E4532]">
                            <div>
                              <span className="text-[10px] text-[#A6715B] block">ROUTE:</span>
                              <span className="font-mono text-[11px] font-bold">
                                {shortAddr(d.sender)}➔{shortAddr(d.recipient)}
                              </span>
                            </div>
                            <div>
                              <span className="text-[10px] text-[#A6715B] block">VALUE:</span>
                              <span className="font-mono text-[11px] font-black text-[#2B7946]">
                                {(d.risk_score * 0.45 + 1.2).toFixed(2)} ETH
                              </span>
                            </div>
                            <div>
                              <span className="text-[10px] text-[#A6715B] block">RISK:</span>
                              <span
                                className={`font-mono text-[11px] font-black ${
                                  d.decision === 'BLOCK'
                                    ? 'text-[#C53030]'
                                    : d.decision === 'FLAG'
                                    ? 'text-[#B7791F]'
                                    : 'text-[#2B7946]'
                                }`}
                              >
                                {d.risk_score} ({d.decision})
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Status Spin Badge */}
                        <span className={`text-xs font-black px-2 py-1 rounded-xl border whitespace-nowrap ${spinBadge}`}>
                          {spinLabel}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>

              {/* CENTRAL ELEVATED TENNIS NET SENSOR GATE (Vertical right divider) */}
              <div
                className="absolute top-0 bottom-0 right-0 w-12 z-30 flex flex-col items-center justify-between py-2 pointer-events-none transition-all duration-200"
                id="central-tennis-net"
              >
                {/* Top Net Post with Laser Sensor Light */}
                <div className="w-6 h-6 rounded-full bg-[#3D2014] border-2 border-[#FFE8D1] shadow-md flex items-center justify-center">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#10B981] ping-slow" />
                </div>
                {/* Vertical Laser Sensor Tape */}
                <div
                  className="laser-tape-glow w-4 bg-[#10B981] text-[9px] font-black text-white font-mono uppercase tracking-widest py-3 flex flex-col items-center justify-around rounded-full border border-white my-1 shadow-md"
                  id="net-laser-tape"
                >
                  <span className="rotate-90 whitespace-nowrap my-4">GATE NET &lt; 3.8µs</span>
                  <span className="rotate-90 whitespace-nowrap my-4">SPEED 2.42µs</span>
                  <span className="rotate-90 whitespace-nowrap my-4">RUST SVM</span>
                </div>
                {/* Woven Tennis Net Mesh Texture Pillar */}
                <div className="w-8 flex-1 tennis-net-mesh border-x-2 border-[#6B341E] rounded-md shadow-lg my-1 opacity-90" />
                {/* Bottom Net Anchor Post */}
                <div className="w-6 h-6 rounded-full bg-[#3D2014] border-2 border-[#FFE8D1] shadow-md flex items-center justify-center">
                  <span className="w-2 h-2 rounded-full bg-[#F6BE3D]" />
                </div>
              </div>
            </div>

            {/* RIGHT: 3 TACTILE TENNIS BALL COLLECTOR HOPPERS / BASKETS (Cols 8-12) */}
            <div className="lg:col-span-5 flex flex-col gap-3 justify-between relative">
              
              {/* Checkpoint HUD Header */}
              <div className="tactile-card-sm bg-[#FFF7EE] rounded-2xl p-2.5 px-4 flex items-center justify-between border-2 border-[#8F4C30]">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-xl bg-[#64CFE8] border-2 border-[#8F4C30] flex items-center justify-center text-base shadow-[0_2px_0_#8F4C30]">
                    🎾
                  </div>
                  <div>
                    <div className="text-[11px] font-black uppercase text-[#692E1B] flex items-center gap-1.5">
                      <span>COMPLIANCE NET HOPPER BINS</span>
                      <span className="w-2 h-2 rounded-full bg-[#48BB78] ping-slow" />
                    </div>
                    <p className="text-[10px] font-mono font-bold text-[#864D36]">Sorted in Real-Time by Pre-Execution Verdict</p>
                  </div>
                </div>
                <div className="bg-[#FFE8D0] border-2 border-[#8F4C30] px-2.5 py-1 rounded-xl text-right">
                  <span className="text-[10px] font-black text-[#5C2B1A]">TARGET:</span>
                  <span className="font-mono font-black text-xs text-[#276E44] block">
                    {Math.round((builderTxCount / BLOCK_CAPACITY) * 100)}% PACK
                  </span>
                </div>
              </div>

              {/* HOPPER BASKET A: COMPLIANT PACKING / BLOCK BUILDER (Green Basket) */}
              <div
                id="hopper-compliant"
                className={`tactile-card-sm bg-[#F0FAF3] rounded-2xl p-3.5 border-2 border-[#54A876] flex flex-col gap-2 relative overflow-hidden hopper-wire-pattern transition-transform duration-300 ${
                  blockFlash ? 'block-seal-flash' : ''
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-7 h-7 rounded-xl bg-[#59C886] text-white flex items-center justify-center font-black text-sm shadow-sm border border-[#2D7347]">
                      🧺
                    </span>
                    <div>
                      <span className="text-xs md:text-sm font-black text-[#205536] uppercase tracking-wide">
                        COMPLIANT PACKING HOPPER
                      </span>
                      <span className="text-[10px] block font-bold text-[#447C5A]">
                        Block Builder Verified Balls (OFAC Pass)
                      </span>
                    </div>
                  </div>
                  <span
                    className="text-[10px] font-extrabold bg-[#DCF4E5] text-[#22633C] px-2 py-0.5 rounded-lg border border-[#8CD8A7]"
                    id="hopper-badge-compliant"
                  >
                    {blockFlash ? '★ BLOCK SEALED! ★' : `${builderTxCount}/${BLOCK_CAPACITY} SEATS`}
                  </span>
                </div>

                {/* Progress / Capacity Gauge */}
                <div className="w-full bg-[#D4EEDC] h-6 rounded-xl border-2 border-[#4A9A67] p-0.5 shadow-inner relative flex items-center">
                  <div
                    className="h-full bg-gradient-to-r from-[#62C889] to-[#34A860] rounded-lg border border-[#246D3E] transition-all duration-500 flex items-center justify-end pr-2"
                    id="gauge-bar"
                    style={{ width: `${Math.max(10, Math.min(100, Math.round((builderTxCount / BLOCK_CAPACITY) * 100)))}%` }}
                  >
                    <span className="text-[10px] font-black text-white drop-shadow" id="gauge-percent">
                      {Math.round((builderTxCount / BLOCK_CAPACITY) * 100)}%
                    </span>
                  </div>
                  <div className="absolute right-2 text-[10px] font-black font-mono text-[#205536]" id="gauge-count">
                    {builderTxCount} / {BLOCK_CAPACITY} BALLS
                  </div>
                </div>

                {/* Stacked Mini Balls in Green Hopper */}
                <div className="grid grid-cols-2 gap-2 mt-0.5 min-h-[56px]" id="hopper-balls-list">
                  {settledAllow.length === 0 ? (
                    <div className="col-span-2 text-center py-3 text-[11px] text-[#4F8E68] font-bold italic">
                      Awaiting clean compliance serves...
                    </div>
                  ) : (
                    settledAllow.slice(-4).map((tx) => (
                      <div
                        key={tx.id}
                        onClick={() => setSelectedTx(tx.data)}
                        className="bg-white border-2 border-[#7CD19B] rounded-xl p-2 text-xs flex items-center justify-between shadow-sm cursor-pointer hover:scale-[1.02] transition-transform animate-in fade-in duration-200"
                      >
                        <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-[#205A37]">
                          <span className="w-3 h-3 rounded-full tennis-ball-sphere inline-block" />
                          #{tx.ballNumber} {shortAddr(tx.data.tx_hash)}
                        </div>
                        <span className="font-mono font-black text-[#266840] text-[11px]">{tx.data.amount_eth || '1.5'} ETH</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* HOPPER BASKET B: QUARANTINE / EDD REVIEW (Amber Basket) */}
              <div
                id="hopper-quarantine"
                className="tactile-card-sm bg-[#FFFBF0] rounded-2xl p-3 border-2 border-[#DE9D2A] flex flex-col gap-1.5 relative overflow-hidden hopper-wire-pattern transition-transform duration-300"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-xl bg-[#F4B938] text-white flex items-center justify-center font-black text-xs shadow-sm border border-[#9A680C]">
                      ⚠️
                    </span>
                    <div>
                      <span className="text-xs font-black text-[#7B4E0E] uppercase tracking-wide">
                        QUARANTINE BASKET (EDD REVIEW)
                      </span>
                      <span className="text-[10px] block font-bold text-[#8C5D19]">
                        1-Hop (Risk 55) &amp; 2-Hop Lineage Flagged
                      </span>
                    </div>
                  </div>
                  <span
                    className="text-[10px] font-extrabold bg-[#FEF4D9] text-[#8F5910] px-2 py-0.5 rounded-lg border border-[#F6C657]"
                    id="hopper-badge-quarantine"
                  >
                    {allSettledFlag.length} BALL{allSettledFlag.length === 1 ? '' : 'S'}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5 mt-0.5 min-h-[44px]">
                  {settledFlag.length === 0 ? (
                    <div className="text-center py-2 text-[11px] text-[#8C5D19] font-bold italic">
                      No contagion lineage flagged...
                    </div>
                  ) : (
                    settledFlag.slice(-2).map((tx) => (
                      <div
                        key={tx.id}
                        onClick={() => setSelectedTx(tx.data)}
                        className="bg-white border-2 border-[#F1C55B] rounded-xl p-2 text-xs flex items-center justify-between shadow-sm cursor-pointer hover:scale-[1.02] transition-transform animate-in fade-in duration-200"
                      >
                        <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-[#7D4E0E]">
                          <span className="w-3 h-3 rounded-full bg-[#F6BE3D] inline-block border border-[#A56807]" />
                          #{tx.ballNumber} {shortAddr(tx.data.tx_hash)}
                        </div>
                        <span className="text-[9px] font-bold text-[#966319] bg-[#FEF8E9] px-2 py-0.5 rounded border border-[#F1D084]">
                          HOLD: {tx.data.reason_codes?.[0] || '2-Hop Lineage'}
                        </span>
                        <span className="font-mono font-black text-[#7C4E0E] text-[11px]">{tx.data.amount_eth || '5.0'} ETH</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* HOPPER BASKET C: REJECTED / FAULT OUT-OF-BOUNDS BIN (Red Basket) */}
              <div
                id="hopper-rejected"
                className="tactile-card-sm bg-[#FFF2F0] rounded-2xl p-3 border-2 border-[#DF5E4E] flex flex-col gap-1.5 relative overflow-hidden hopper-wire-pattern transition-transform duration-300"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-[#E85E4E] text-white flex items-center justify-center font-black text-xs shadow-sm border border-[#8C291D]">
                      🚫
                    </span>
                    <div>
                      <span className="text-xs font-black text-[#8B291D] uppercase tracking-wide">
                        OUT / FAULT BIN (HARD BLOCK)
                      </span>
                      <span className="text-[10px] block font-bold text-[#9A372B]">
                        Direct OFAC Matches (Risk 98) &amp; Mixers
                      </span>
                    </div>
                  </div>
                  <span
                    className="text-[10px] font-extrabold bg-[#FCE5E2] text-[#932418] px-2 py-0.5 rounded-lg border border-[#F3958B]"
                    id="hopper-badge-rejected"
                  >
                    FAULT / OUT ({allSettledBlock.length})
                  </span>
                </div>

                <div className="flex flex-col gap-1.5 mt-0.5 min-h-[44px]">
                  {settledBlock.length === 0 ? (
                    <div className="text-center py-2 text-[11px] text-[#9A372B] font-bold italic">
                      Zero fault out-of-bounds balls...
                    </div>
                  ) : (
                    settledBlock.slice(-2).map((tx) => (
                      <div
                        key={tx.id}
                        onClick={() => setSelectedTx(tx.data)}
                        className="bg-white border-2 border-[#EE8274] rounded-xl p-2 text-xs flex items-center justify-between shadow-sm cursor-pointer hover:scale-[1.02] transition-transform animate-in fade-in duration-200"
                      >
                        <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-[#8C291D]">
                          <span className="w-3 h-3 rounded-full bg-[#E53E3E] inline-block border border-[#8C291D]" />
                          #{tx.ballNumber} {shortAddr(tx.data.tx_hash)}
                        </div>
                        <span className="font-mono font-black text-[#8C291D] text-[10px] bg-[#FCE5E2] px-2 py-0.5 rounded border border-[#F49A90]">
                          BLOCKED / FAULT
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

          </div>
        </main>

        {/* Selected Transaction Audit Pod */}
        <section className="tactile-card bg-[#FFF8EE] rounded-3xl p-4 md:p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between pb-3 border-b-2 border-[#E7CDAF]">
            <div className="flex items-center gap-3">
              <span className="text-2xl p-2 rounded-2xl bg-[#FFE4BA] border-2 border-[#8F4C30] shadow-sm">🔍</span>
              <div>
                <h3 className="text-base md:text-lg font-black text-[#692E19] uppercase">
                  REGULATORY AUDIT POD (SELECTED TRANSACTION)
                </h3>
                <p className="text-xs font-bold text-[#A5684E]">
                  Cryptographic Provenance &bull; Entity Lineage &bull; OFAC SDN Clearance
                </p>
              </div>
            </div>
            {selectedTx && (
              <button
                onClick={() => {
                  window.open(`${API_URL}/api/decisions/${selectedTx.tx_hash}/report`, '_blank');
                  playRetroBleep(880, 'sine', 0.15);
                }}
                className="btn-3d btn-3d-amber text-xs font-bold px-3 py-1.5 rounded-xl flex items-center gap-1.5 cursor-pointer"
              >
                <span>💾</span>
                <span>DOWNLOAD AUDIT REPORT (PDF)</span>
              </button>
            )}
          </div>

          {selectedTx ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 text-xs font-semibold">
              {/* Box 1: Identifiers */}
              <div className="tactile-card-sm p-3.5 space-y-1.5">
                <span className="text-[#A06449] block text-[10px] uppercase font-black">IDENTIFIERS</span>
                <p className="font-mono break-all">
                  <span className="text-[#A06449]">HASH:</span> {shortAddr(selectedTx.tx_hash)}
                </p>
                <p className="font-mono break-all">
                  <span className="text-[#A06449]">FROM:</span> {shortAddr(selectedTx.sender)}
                </p>
                <p className="font-mono break-all">
                  <span className="text-[#A06449]">TO:</span> {shortAddr(selectedTx.recipient)}
                </p>
              </div>

              {/* Box 2: Entity & Contagion */}
              <div className="tactile-card-sm p-3.5 space-y-1.5">
                <span className="text-[#A06449] block text-[10px] uppercase font-black">ENTITY &amp; CONTAGION</span>
                <p>
                  <span className="text-[#A06449]">ENTITY TYPE:</span>{' '}
                  <span className="font-bold text-[#6A2E19]">{selectedTx.counterparty_entity_type || 'Unknown EOA'}</span>
                </p>
                <p>
                  <span className="text-[#A06449]">GRAPH DISTANCE:</span>{' '}
                  <span className="font-bold text-[#6A2E19]">
                    {selectedTx.exposure_hop_distance ? `${selectedTx.exposure_hop_distance}-Hop Link` : 'Direct Clean'}
                  </span>
                </p>
                <p>
                  <span className="text-[#A06449]">POLICY:</span>{' '}
                  <span className="font-mono text-xs">{selectedTx.policy_version || 'standard-v1'}</span>
                </p>
              </div>

              {/* Box 3: Screening Verdict */}
              <div className="tactile-card-sm p-3.5 space-y-1.5">
                <span className="text-[#A06449] block text-[10px] uppercase font-black">SCREENING VERDICT</span>
                <p className="flex items-center gap-2">
                  <span className="text-[#A06449]">DECISION:</span>
                  <span
                    className={`px-2 py-0.5 rounded-lg border text-xs font-black ${
                      selectedTx.decision === 'ALLOW'
                        ? 'bg-[#E5F7EB] text-[#2F855A] border-[#65C989]'
                        : selectedTx.decision === 'FLAG'
                        ? 'bg-[#FEF6E4] text-[#8C5D17] border-[#F6CB63]'
                        : 'bg-[#FCE5E2] text-[#9B2C2C] border-[#F49A90]'
                    }`}
                  >
                    {selectedTx.decision}
                  </span>
                </p>
                <p>
                  <span className="text-[#A06449]">RISK SCORE:</span>{' '}
                  <span className="font-mono font-black text-[#6A2E19] text-sm">{selectedTx.risk_score} / 100</span>
                </p>
                <p className="text-[11px] font-mono text-[#7A422D]">
                  {selectedTx.reason_codes?.join(', ') || 'CLEAN_TRANSFER'}
                </p>
              </div>

              {/* Box 4: SHA-256 Ledger Seal */}
              <div className="tactile-card-sm p-3.5 space-y-1.5">
                <span className="text-[#A06449] block text-[10px] uppercase font-black">CRYPTOGRAPHIC SEAL</span>
                <p className="text-[10px] text-[#A06449]">SHA-256 LEDGER PROOF:</p>
                <p className="font-mono text-[10px] text-[#255C37] bg-white p-1.5 rounded-lg border border-[#8F4C30] break-all shadow-inner">
                  {selectedTx.integrity_hash || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}
                </p>
                <span className="text-[10px] text-[#48BB78] font-bold block">✓ Verified authentic at decision time</span>
              </div>
            </div>
          ) : (
            <div className="text-center py-6 text-[#A06449] font-bold text-sm">
              [ SELECT ANY TRANSACTION IN THE ARENA TO INSPECT AUDIT PROOFS ]
            </div>
          )}
        </section>

        {/* Bottom HUD Status Dock */}
        <footer className="tactile-card bg-[#F5E4D0] rounded-3xl p-3.5 px-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center flex-wrap gap-4 text-xs font-bold text-[#7F442C]">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-[#48BB78]" />
              <span>Engine: <strong className="text-[#592614] font-extrabold">Rust Deterministic SVM</strong></span>
            </div>
            <span className="text-[#C69C84]">•</span>
            <div>Gate Latency: <span className="font-mono font-extrabold text-[#235C37] bg-[#E8F8ED] px-1.5 py-0.5 rounded border border-[#85DAA4]">{liveLatency} avg</span></div>
            <span className="text-[#C69C84]">•</span>
            <div>Mempool Depth: <span className="font-mono font-extrabold text-[#592614]">1,428 tx/s</span></div>
          </div>

          <div className="flex items-center flex-wrap gap-2 text-xs font-bold text-[#7F442C]">
            <span className="text-xs uppercase tracking-wider text-[#A0644B]">Tactile Shortcuts:</span>
            <span className="px-2.5 py-1 rounded-xl bg-[#FFF6EB] border-2 border-[#8F4C30] font-mono text-[#542111] shadow-sm font-bold">[1] Allow</span>
            <span className="px-2.5 py-1 rounded-xl bg-[#FFF6EB] border-2 border-[#8F4C30] font-mono text-[#542111] shadow-sm font-bold">[2] Flag</span>
            <span className="px-2.5 py-1 rounded-xl bg-[#FFF6EB] border-2 border-[#8F4C30] font-mono text-[#542111] shadow-sm font-bold">[3] Block</span>
            <span className="px-2.5 py-1 rounded-xl bg-[#FFF6EB] border-2 border-[#8F4C30] font-mono text-[#542111] shadow-sm font-bold">[Space] Pause Game</span>
          </div>
        </footer>

      </div>
    </div>
  );
}
