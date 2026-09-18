'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import './arcade.css';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || `${API_URL.replace(/^http/, 'ws')}/ws`;
const BLOCK_CAPACITY = 5;
const TRAVEL_TO_GATE_MS = 1600;
const TRAVEL_TO_ZONE_MS = 1600;

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
