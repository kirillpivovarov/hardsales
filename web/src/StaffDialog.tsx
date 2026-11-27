import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from './i18n';
import { Button } from './ui';

export function StaffDialog({ title, onClose, children, closeDisabled = false, returnFocus, returnFocusOverride }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeDisabled?: boolean;
  returnFocus?: HTMLElement | null;
  returnFocusOverride?: RefObject<HTMLElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const { t } = useI18n();

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const trigger = returnFocus ?? document.activeElement;
    node.showModal();
    heading.current?.focus({ preventScroll: true });
    return () => {
      node.close();
      const fallback = returnFocusOverride?.current;
      if (fallback?.isConnected) fallback.focus();
      else if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [returnFocus, returnFocusOverride]);

  return createPortal(<dialog ref={dialog} className="admin-dialog panel" aria-labelledby={titleId} onCancel={event => {
    event.preventDefault();
    event.stopPropagation();
    if (!closeDisabled) onClose();
  }}>
    <div className="admin-dialog-header">
      <h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2>
      <Button variant="ghost" disabled={closeDisabled} onClick={onClose}>{t('Закрыть')}</Button>
    </div>
    <div className="admin-dialog-body">{children}</div>
  </dialog>, document.body);
}
