import React from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => {
    const variants = {
      primary: 'bg-[var(--accent)] text-[var(--on-accent)] hover:bg-[var(--accent-hover)]',
      secondary: 'bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] hover:bg-slate-100',
      ghost: 'bg-transparent text-[var(--text)] hover:bg-slate-100',
      danger: 'bg-[var(--danger)] text-[var(--on-danger)] hover:opacity-90',
    };
    const sizes = {
      sm: 'h-8 px-3 text-xs',
      md: 'h-10 px-4 text-sm',
      lg: 'h-12 px-5 text-base',
    };
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-[10px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:opacity-50 disabled:pointer-events-none cursor-pointer',
          variants[variant],
          sizes[size],
          className
        )}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-10 w-full rounded-[10px] border border-[var(--border-input)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--text-muted)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
);
Input.displayName = 'Input';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-[14px] border border-[var(--border)] bg-[var(--surface-raised)] shadow-xs', className)}
      {...props}
    />
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-slate-100 text-slate-700 border-slate-200',
    accent: 'bg-teal-50 text-teal-800 border-teal-200',
    success: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    warning: 'bg-amber-50 text-amber-800 border-amber-200',
    danger: 'bg-red-50 text-red-800 border-red-200',
  };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium', tones[tone], className)}>
      {children}
    </span>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-slate-950/40 backdrop-blur-[1px]" onClick={onClose}>
      <div
        className="w-full md:max-w-lg max-h-[88dvh] overflow-y-auto rounded-t-2xl md:rounded-2xl bg-[var(--bg)] border border-[var(--border)] p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-[var(--border)]">
          <h3 className="text-base font-semibold text-[var(--text)]">{title}</h3>
          <button onClick={onClose} className="text-sm text-[var(--text-muted)] hover:text-[var(--text)] px-2 py-1 cursor-pointer">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
