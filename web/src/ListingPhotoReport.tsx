import { useRef, useState } from 'react';
import { api, ApiError } from './api';
import { useI18n } from './i18n';
import { StaffDialog } from './StaffDialog';
import { Button, Notice } from './ui';

export function ListingPhotoReport({ listingId }: { listingId: string }) {
  const { t } = useI18n();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api('/listings/' + encodeURIComponent(listingId) + '/reports', { method: 'POST', body: { reason: 'CONTACT_PHOTO' } });
      setSent(true);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Не удалось отправить жалобу.');
    } finally {
      setBusy(false);
    }
  }

  return <div className="detail-photo-report">
    <button ref={trigger} type="button" className="button button-ghost" aria-haspopup="dialog" aria-disabled={sent}
      onClick={() => { if (!sent) setOpen(true); }}>{t(sent ? 'Жалоба отправлена' : 'Сообщить о контактах на фото')}</button>
    {sent && <span className="sr-only" role="status">{t('Жалоба отправлена модератору.')}</span>}
    {open && <StaffDialog title={t('Контакты на фото')} returnFocus={trigger.current} onClose={() => setOpen(false)} closeDisabled={busy}>
      <p>{t('Площадка проверит фотографии объявления на наличие телефонов, адресов и имён пользователей в мессенджерах.')}</p>
      {error && <Notice tone="error">{t(error)}</Notice>}
      <div className="admin-actions">
        <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>{t('Отмена')}</Button>
        <Button disabled={busy} onClick={() => void submit()}>{t('Отправить жалобу')}</Button>
      </div>
    </StaffDialog>}
  </div>;
}
