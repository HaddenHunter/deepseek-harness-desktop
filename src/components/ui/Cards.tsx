import type { ReactNode } from "react";

export function SectionCard({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={"space-y-3 " + className}>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="dsh-section-title !mb-0">{title}</div>
          {subtitle && <div className="text-[11.5px] text-slate-500 mt-1">{subtitle}</div>}
        </div>
        {actions}
      </div>
      <div
        className="dsh-card"
        style={{
          padding: 0,
          overflow: "hidden",
        }}
      >
        <div className="p-4 sm:p-5">{children}</div>
      </div>
    </section>
  );
}

export function KeyValueRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr] gap-3 sm:gap-5 py-3 items-start">
      <div>
        <div className="dsh-label !mb-0">{label}</div>
        {hint && <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Divider({ className = "" }: { className?: string }) {
  return (
    <div
      className={
        "border-t border-white/[0.07] my-2 " + className
      }
    />
  );
}
