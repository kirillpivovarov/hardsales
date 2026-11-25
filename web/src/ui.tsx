import type { ButtonHTMLAttributes, ReactNode } from 'react';
import {
  Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, CircleAlert,
  CircleCheck, CircuitBoard, ClipboardList, Cpu, Fan, Gpu, HardDrive,
  Info, Layers, ListFilter, LoaderCircle, Lock, LockKeyhole, MapPin,
  MemoryStick, Menu, MessageCircle, MessagesSquare, Network, PanelsTopLeft, Plus,
  Search, SearchX, Send, Server, SlidersHorizontal, Star, Tag,
  TriangleAlert, UserRound, X, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from './i18n';

const iconMap: Record<string, LucideIcon> = {
  Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle, CircleAlert,
  CircleCheck, CircuitBoard, ClipboardList, Cpu, Fan, Gpu, HardDrive,
  Info, Layers, ListFilter, LoaderCircle, Lock, LockKeyhole, MapPin,
  MemoryStick, Menu, MessageCircle, MessagesSquare, Network, PanelsTopLeft, Plus,
  Search, SearchX, Send, Server, SlidersHorizontal, Star, Tag,
  TriangleAlert, UserRound, X, Zap,
};

export function Icon({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  const key = name.replace(/(^|-)(\w)/g, (_, _dash: string, letter: string) => letter.toUpperCase());
  const Component = iconMap[key] ?? iconMap.Circle;
  return <Component size={size} strokeWidth={1.75} className={className} aria-hidden="true" />;
}

export function Button({ className = '', variant = 'primary', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return <button type={type} className={`button button-${variant} ${className}`} {...props} />;
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'success' }) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon name={tone === 'error' ? 'circle-alert' : tone === 'success' ? 'circle-check' : 'info'} /><div>{children}</div>
  </div>;
}

export function Spinner() {
  const { t } = useI18n();
  return <div className="spinner" role="status"><Icon name="loader-circle" /> {t('Загрузка…')}</div>;
}
