"use client";

/**
 * Shared visual primitives.
 *
 * Two rules hold this together:
 *   1. No component takes a raw colour. Everything routes through the semantic
 *      tokens in globals.css, so the palette can move in one place.
 *   2. Severity is never carried by colour alone — every toned element pairs
 *      its colour with an icon or a word. Roughly one in twelve men has some
 *      colour-vision deficiency, and this is a document about money.
 */

import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock,
  Info,
  type LucideIcon,
} from "lucide-react";

export type Tone = "danger" | "warn" | "good" | "info" | "neutral";

const TONE_STYLE: Record<Tone, { bg: string; text: string; border: string; icon: LucideIcon }> = {
  danger: { bg: "bg-[var(--color-danger-bg)]", text: "text-[var(--color-danger)]", border: "border-[var(--color-danger-line)]", icon: CircleAlert },
  warn: { bg: "bg-[var(--color-warn-bg)]", text: "text-[var(--color-warn)]", border: "border-[var(--color-warn-line)]", icon: AlertTriangle },
  good: { bg: "bg-[var(--color-good-bg)]", text: "text-[var(--color-good)]", border: "border-[var(--color-good-line)]", icon: CheckCircle2 },
  info: { bg: "bg-[var(--color-info-bg)]", text: "text-[var(--color-info)]", border: "border-[var(--color-info-line)]", icon: Info },
  neutral: { bg: "bg-[var(--color-surface-sunken)]", text: "text-[var(--color-ink-soft)]", border: "border-[var(--color-line)]", icon: Clock },
};

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag
      className={cx(
        "rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)]",
        "shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-end justify-between gap-6">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--color-gold)]">
            {eyebrow}
          </div>
        )}
        <h2 className="text-[19px] font-semibold text-[var(--color-ink)]">{title}</h2>
        {description && (
          <p className="mt-1 max-w-2xl text-[13.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {description}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Badge({
  tone = "neutral",
  children,
  icon: IconOverride,
  showIcon = true,
}: {
  tone?: Tone;
  children: ReactNode;
  icon?: LucideIcon;
  showIcon?: boolean;
}) {
  const style = TONE_STYLE[tone];
  const Icon = IconOverride ?? style.icon;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-[3px]",
        "text-[11px] font-semibold uppercase tracking-[0.06em]",
        style.bg,
        style.text,
        style.border,
      )}
    >
      {showIcon && <Icon size={12} strokeWidth={2.5} aria-hidden />}
      {children}
    </span>
  );
}

/** Severity dot plus label. The label is what conveys meaning; the dot assists. */
export function Severity({ tone, label }: { tone: Tone; label: string }) {
  const style = TONE_STYLE[tone];
  return (
    <span className="inline-flex items-center gap-2 text-[12px] font-medium text-[var(--color-ink-soft)]">
      <span className={cx("h-2 w-2 shrink-0 rounded-full ring-2", style.text)} style={{ background: "currentColor" }} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------

export function Money({
  children,
  size = "md",
  tone,
  className,
}: {
  children: ReactNode;
  size?: "sm" | "md" | "lg";
  tone?: Tone;
  className?: string;
}) {
  const sizes = { sm: "text-[12.5px]", md: "text-[14px]", lg: "text-[17px] font-semibold" };
  return (
    <span
      className={cx(
        "money whitespace-nowrap",
        sizes[size],
        tone ? TONE_STYLE[tone].text : "text-[var(--color-ink)]",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">
        {label}
      </div>
      <div
        className={cx(
          "money mt-1.5 text-[22px] font-semibold tracking-tight",
          tone === "neutral" ? "text-[var(--color-ink)]" : TONE_STYLE[tone].text,
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[12px] leading-snug text-[var(--color-ink-muted)]">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Button({
  children,
  onClick,
  variant = "secondary",
  size = "md",
  icon: Icon,
  disabled,
  type = "button",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: LucideIcon;
  disabled?: boolean;
  type?: "button" | "submit";
  title?: string;
}) {
  const variants = {
    primary:
      "bg-[var(--color-navy)] text-white border-[var(--color-navy)] hover:bg-[var(--color-navy-soft)]",
    secondary:
      "bg-[var(--color-surface)] text-[var(--color-ink)] border-[var(--color-line-strong)] hover:bg-[var(--color-surface-sunken)]",
    ghost:
      "bg-transparent text-[var(--color-ink-soft)] border-transparent hover:bg-[var(--color-surface-sunken)]",
    danger:
      "bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger-line)] hover:bg-[#fde8e8]",
  };
  const sizes = {
    // 36px and 32px tall. Anything smaller fails the 44px touch guidance on
    // the tablets these get reviewed on, so the tap area is padded by the
    // surrounding row rather than shrinking the control further.
    md: "h-9 px-3.5 text-[13px] gap-2",
    sm: "h-8 px-3 text-[12.5px] gap-1.5",
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cx(
        "inline-flex cursor-pointer items-center justify-center rounded-lg border font-medium",
        "transition-colors duration-150 ease-out",
        "disabled:cursor-not-allowed disabled:opacity-45",
        variants[variant],
        sizes[size],
      )}
    >
      {Icon && <Icon size={size === "sm" ? 14 : 15} strokeWidth={2} aria-hidden />}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------

/**
 * Proportion bar. Always accompanied by the figure it represents — a bar
 * alone is decoration, a bar next to its number is evidence.
 */
export function Bar({ share, tone = "danger" }: { share: number; tone?: Tone }) {
  const pct = Math.max(0, Math.min(1, share)) * 100;
  const fill = {
    danger: "bg-[var(--color-danger)]",
    warn: "bg-[var(--color-warn)]",
    good: "bg-[var(--color-good)]",
    info: "bg-[var(--color-info)]",
    neutral: "bg-[var(--color-ink-faint)]",
  }[tone];

  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface-sunken)]">
      <div
        className={cx("h-full rounded-full transition-[width] duration-500 ease-out", fill)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function EmptyState({
  icon: Icon = CheckCircle2,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 rounded-full bg-[var(--color-good-bg)] p-3 text-[var(--color-good)]">
        <Icon size={22} strokeWidth={1.75} aria-hidden />
      </div>
      <h3 className="text-[15px] font-semibold text-[var(--color-ink)]">{title}</h3>
      <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Inline statutory citation. Small, monospaced, always present on a finding. */
export function Citation({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[11px] tracking-tight text-[var(--color-ink-muted)]">
      {children}
    </span>
  );
}

export function ArrowLink({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group inline-flex cursor-pointer items-center gap-1 text-[13px] font-medium text-[var(--color-ink)] hover:text-[var(--color-gold)]"
    >
      {children}
      <ArrowRight
        size={14}
        strokeWidth={2}
        className="transition-transform duration-150 ease-out group-hover:translate-x-0.5"
        aria-hidden
      />
    </button>
  );
}

export { TONE_STYLE };
