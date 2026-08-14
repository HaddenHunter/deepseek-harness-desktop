import { useEffect, type ReactNode } from "react";

/**
 * Generic centered modal shell with glass backdrop.
 *
 * Usage:
 *   {open && (
 *     <ModalShell title="..." onClose={...} footer={<Btn onClick={ok}>确定</Btn>}>
 *       body
 *     </ModalShell>
 *   )}
 */
export default function ModalShell({
  open = true,
  title,
  onClose,
  children,
  footer,
  width = 640,
  preventClose = false,
}: {
  open?: boolean;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  preventClose?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !preventClose) onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, preventClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] grid place-items-center p-4 sm:p-8"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="absolute inset-0"
        onClick={preventClose ? undefined : onClose}
        style={{
          background:
            "radial-gradient(1200px 600px at 50% 0%, rgba(108,140,255,0.22), rgba(10, 10, 15, 0.82) 60%), rgba(0,0,0,0.6)",
          backdropFilter: "blur(8px)",
        }}
      />
      <div
        className="relative w-full rounded-3xl overflow-hidden flex flex-col"
        style={{
          width: "100%",
          maxWidth: width,
          maxHeight: "calc(100vh - 80px)",
          background:
            "linear-gradient(180deg, rgba(30,32,45,0.98), rgba(18,19,28,0.98))",
          border: "1px solid rgba(255,255,255,0.08)",
          boxShadow:
            "0 0 0 1px rgba(255,255,255,0.04) inset, 0 40px 100px -20px rgba(0,0,0,0.95), 0 0 80px -10px rgba(108,140,255,0.35)",
        }}
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-80"
          aria-hidden
          style={{
            background:
              "radial-gradient(600px 180px at 10% -10%, rgba(108,140,255,0.22), transparent 70%), radial-gradient(600px 180px at 90% -10%, rgba(147,51,234,0.2), transparent 70%)",
          }}
        />
        {title && (
          <div className="relative z-10 flex items-center justify-between px-5 h-14 shrink-0"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="text-[14px] font-semibold tracking-tight text-white">
              {title}
            </div>
            {!preventClose && (
              <button
                onClick={onClose}
                className="w-8 h-8 rounded-xl grid place-items-center text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
                title="关闭 (Esc)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        )}
        <div className="relative z-10 flex-1 min-h-0 overflow-y-auto p-5">{children}</div>
        {footer && (
          <div
            className="relative z-10 px-5 py-3.5 flex items-center justify-end gap-2 shrink-0"
            style={{
              borderTop: "1px solid rgba(255,255,255,0.06)",
              background: "linear-gradient(0deg, rgba(255,255,255,0.03), rgba(255,255,255,0))",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
