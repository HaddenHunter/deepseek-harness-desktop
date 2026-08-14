import { useEffect, useRef, useState } from "react";
import { useUIStore } from "@/store/ui";

const AVATAR_EMOJI: Record<string, string> = {
  fox: "🦊",
  cat: "🐱",
  dog: "🐶",
  raccoon: "🦝",
  custom: "✨",
};

/**
 * DesktopPetHost
 * ---------
 * Skeleton / entry point for the future "desktop pet" floating widget.
 *
 * Only mounts anything when `settings.desktopPet.enabled` is true; otherwise
 * renders nothing so the app bundle stays free of animation code until the
 * feature is actually shipped. When enabled it renders a lightweight
 * draggable placeholder so we can validate:
 *
 *   1. settings persist correctly across boot;
 *   2. z-order / anchoring works against the chat window;
 *   3. the right-click context menu hook has its place;
 *   4. we know exactly where the real Lottie / emoji state machine will plug in.
 *
 * Real implementation roadmap (replace the placeholder body):
 *   - Renderer: Lottie dotlottie file or CSS-keyframe sprites per mood
 *     (idle/curious/working/happy + reaction bursts for runtime events).
 *   - Interaction: drag-to-move with anchor snap; double-click for quick
 *     action (e.g. open chat, pop last event); right-click → menu below.
 *   - Event bridge: subscribe to `runtime.onEvent` in a useEffect here,
 *     map `tool_call`/`error`/`milestone` → short-lived thought bubbles
 *     / emoji reactions on the pet.
 */
export default function DesktopPetHost() {
  const settings = useUIStore((s) => s.settings);
  const saveSettings = useUIStore((s) => s.saveSettings);
  const setView = useUIStore((s) => s.setView);

  const pet = settings?.desktopPet;
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (!pet) return { x: -1, y: -1 };
    if (pet.position.x >= 0 && pet.position.y >= 0) return pet.position;
    return { x: -1, y: -1 };
  });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const drag = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    if (!pet?.enabled) return;
    if (pet.anchor !== "floating" && pos.x < 0) {
      // compute default position based on anchor on first mount
      const w = typeof window !== "undefined" ? window.innerWidth : 1280;
      const h = typeof window !== "undefined" ? window.innerHeight : 800;
      const s = pet.size;
      const pad = 24;
      const corner = {
        "bottom-right": { x: w - s - pad, y: h - s - pad - 32 },
        "bottom-left": { x: pad, y: h - s - pad - 32 },
        "top-right": { x: w - s - pad, y: pad + 48 },
        "top-left": { x: pad, y: pad + 48 },
        floating: { x: -1, y: -1 },
      } as const;
      const c = corner[pet.anchor];
      if (c.x >= 0) {
        setPos({ x: c.x, y: c.y });
        void saveSettings({ desktopPet: { ...pet, position: { x: c.x, y: c.y } } });
      }
    }
  }, [pet?.enabled, pet?.anchor, pet?.size, pos.x, saveSettings, pet]);

  if (!pet?.enabled) return null;

  const size = pet.size;
  const left = pos.x >= 0 ? pos.x : window.innerWidth - size - 24;
  const top = pos.y >= 0 ? pos.y : window.innerHeight - size - 24 - 32;

  const hide = () => void saveSettings({ desktopPet: { ...pet, enabled: false } });

  const onMouseDown = (e: React.MouseEvent) => {
    if (!pet.interactive) return;
    if (e.button !== 0) return;
    drag.current = { startX: e.clientX, startY: e.clientY, origX: left, origY: top };
    setMenu(null);
    const onMove = (ev: MouseEvent) => {
      if (!drag.current) return;
      const nx = Math.max(0, Math.min(window.innerWidth - size, drag.current.origX + (ev.clientX - drag.current.startX)));
      const ny = Math.max(0, Math.min(window.innerHeight - size, drag.current.origY + (ev.clientY - drag.current.startY)));
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      if (drag.current) {
        void saveSettings({ desktopPet: { ...pet, anchor: "floating", position: { ...pos } } });
      }
      drag.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onContext = (e: React.MouseEvent) => {
    if (!pet.interactive) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  return (
    <>
      <div
        data-desktop-pet
        data-mood={pet.mood}
        data-avatar={pet.avatar}
        onMouseDown={onMouseDown}
        onContextMenu={onContext}
        onClick={() => {
          if (!pet.interactive) return;
          /* future: cycle mood, or open quick event bubble */
        }}
        title="桌面宠物（占位骨架：未来接入动画 + 事件气泡）"
        className={[
          "fixed z-50 select-none",
          pet.interactive ? "cursor-grab active:cursor-grabbing" : "pointer-events-none",
        ].join(" ")}
        style={{
          width: size,
          height: size,
          left,
          top,
          opacity: pet.opacity,
        }}
      >
        {/* -------- PLACEHOLDER WIDGET (replace with real pet renderer below) -------- */}
        <div className="w-full h-full rounded-3xl border border-dashed border-dsh-accent/50 bg-dsh-accent/5 backdrop-blur-sm grid place-items-center shadow-xl shadow-dsh-accent/10 transition hover:shadow-dsh-accent/30">
          <div
            className="leading-none"
            style={{ fontSize: Math.max(32, Math.round(size * 0.45)) }}
          >
            {pet.avatar === "custom" && pet.customAvatarUrl ? (
              <img src={pet.customAvatarUrl} alt="custom pet" className="w-[70%] h-[70%] object-contain mx-auto" />
            ) : (
              AVATAR_EMOJI[pet.avatar] ?? "🐾"
            )}
          </div>
          <div className="absolute bottom-1 left-0 right-0 text-center text-[10px] text-dsh-accent/80 font-medium">
            {pet.mood} · pet
          </div>
        </div>
        {/* TODO(desktop-pet): plug Lottie / CSS state machine here, e.g.
            <PetRenderer avatar={pet.avatar} mood={pet.mood} reacting={lastEventRef.current} /> */}
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
          <div
            className="fixed z-[60] min-w-[160px] rounded-md border border-dsh-border bg-dsh-bg/95 backdrop-blur text-xs shadow-xl py-1"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-dsh-accent/15 text-slate-200"
              onClick={() => {
                setMenu(null);
                setView("settings");
              }}
            >
              ⚙️ 宠物设置…
            </button>
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-dsh-accent/15 text-slate-200"
              onClick={() => {
                setMenu(null);
                void saveSettings({
                  desktopPet: {
                    ...pet,
                    mood: pet.mood === "happy" ? "idle" : "happy",
                  },
                });
              }}
            >
              😺 切换心情（占位）
            </button>
            <div className="my-1 border-t border-dsh-border" />
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-red-500/10 text-red-300"
              onClick={() => {
                setMenu(null);
                hide();
              }}
            >
              🙈 隐藏宠物
            </button>
          </div>
        </>
      )}
    </>
  );
}
