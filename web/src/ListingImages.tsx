import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useI18n } from './i18n';
import type { ListingImage } from './market';
import { Button, Icon, Notice } from './ui';
import './listing-images.css';

const PHOTO_LIMIT = 10;
const PHOTO_SIZE_LIMIT = 8 * 1024 * 1024;
const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type ListingImageDraft = { key: string; image: ListingImage } | { key: string; file: File };

export function listingImagePayload(data: object, drafts: ListingImageDraft[] | undefined, saved: ListingImage[] = []) {
  if (!drafts || (drafts.length === saved.length && drafts.every((entry, index) => 'image' in entry && entry.image.id === saved[index].id))) {
    return data;
  }
  const files: File[] = [];
  const imageOrder = drafts.map(draft => {
    if ('image' in draft) return draft.image.id;
    const fileIndex = files.length;
    files.push(draft.file);
    return { fileIndex };
  });
  if (!files.length) return { ...data, imageOrder };

  const multipart = new FormData();
  multipart.set('data', JSON.stringify({ ...data, imageOrder }));
  for (const file of files) multipart.append('images', file);
  return multipart;
}

export function ListingPhoto({ src, alt, ...props }: {
  src: string;
  alt: string;
  loading?: 'lazy';
  width?: number;
  height?: number;
}) {
  const { t } = useI18n();
  const [failed, setFailed] = useState<string>();
  if (!src || failed === src) {
    return <span className="listing-photo-fallback">
      <Icon name="layers" size={24} />
      {t('Фото недоступно')}
    </span>;
  }
  return <img src={src} alt={alt} decoding="async" onError={() => setFailed(src)} {...props} />;
}

function DraftPhoto({ draft }: { draft: ListingImageDraft }) {
  const file = 'file' in draft ? draft.file : null;
  const [preview, setPreview] = useState('');

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  if ('image' in draft) {
    return <ListingPhoto src={draft.image.url} alt="" loading="lazy" />;
  }
  return preview ? <ListingPhoto src={preview} alt="" loading="lazy" /> : null;
}

export function ListingImagesEditor({ drafts, disabled, onChange }: {
  drafts: ListingImageDraft[];
  disabled: boolean;
  onChange: (drafts: ListingImageDraft[]) => void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const serial = useRef(0);
  const [warnings, setWarnings] = useState<string[]>([]);

  function addPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;

    const next = drafts.slice();
    const messages = new Set<string>();
    for (const file of files) {
      const knownType = supportedTypes.has(file.type) || (!file.type && /\.(jpe?g|png|webp)$/i.test(file.name));
      if (!knownType) {
        messages.add('Выберите фото в формате JPEG, PNG или WebP.');
      } else if (!file.size || file.size > PHOTO_SIZE_LIMIT) {
        messages.add('Каждое фото должно быть непустым и весить не более 8 МБ.');
      } else if (next.length >= PHOTO_LIMIT) {
        messages.add('К объявлению можно прикрепить до 10 фото.');
      } else {
        next.push({ key: `local-${serial.current++}`, file });
      }
    }
    setWarnings(Array.from(messages));
    if (next.length !== drafts.length) onChange(next);
  }

  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= drafts.length) return;
    const next = drafts.slice();
    const [entry] = next.splice(from, 1);
    next.splice(to, 0, entry);
    onChange(next);
  }

  function remove(key: string) {
    setWarnings([]);
    onChange(drafts.filter(draft => draft.key !== key));
  }

  return <section className="panel workflow-section listing-photos">
    <h2>{t('Фотографии')}</h2>
    <p className="listing-photos-hint muted">
      {t('Добавьте до 10 фото в формате JPEG, PNG или WebP без анимации. Размер каждого файла — до 8 МБ.')}
      {' '}
      {t('При сохранении фото уменьшаются до 900 пикселей по большей стороне. На них появится водяной знак hwforai. Первое фото станет обложкой.')}
    </p>
    <div className="listing-photo-picker">
      <input
        ref={input}
        hidden
        disabled={disabled}
        type="file"
        name="listingImages"
        accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
        multiple
        onChange={addPhotos}
      />
      <Button variant="secondary" disabled={disabled || drafts.length >= PHOTO_LIMIT} onClick={() => input.current?.click()}>
        <Icon name="plus" />{t('Добавить фото')}
      </Button>
      <span role="status" className="muted">{t('{count} из {limit} фото', { count: drafts.length, limit: PHOTO_LIMIT })}</span>
    </div>
    {warnings.length > 0 && <Notice tone="error">{warnings.map(message => <p key={message}>{t(message)}</p>)}</Notice>}
    {drafts.length > 0 && <ol className="listing-photo-editor-grid">
      {drafts.map((draft, index) => {
        const number = index + 1;
        const coverLabel = t('Сделать фото {number} обложкой', { number });
        const earlierLabel = t('Переместить фото {number} раньше', { number });
        const laterLabel = t('Переместить фото {number} позже', { number });
        const removeLabel = t('Удалить фото {number}', { number });
        return <li key={draft.key} className="listing-photo-draft">
          <div className="listing-photo-preview">
            <DraftPhoto draft={draft} />
          </div>
          <div className="listing-photo-label">
            <span>{t('Фото {number}', { number })}</span>
            {index === 0 && <span className="listing-photo-cover">{t('Обложка')}</span>}
          </div>
          <div className="listing-photo-actions">
            <Button variant="ghost" disabled={disabled || index === 0} aria-label={coverLabel} title={coverLabel} onClick={() => move(index, 0)}>
              <Icon name="star" size={16} />
            </Button>
            <Button variant="ghost" disabled={disabled || index === 0} aria-label={earlierLabel} title={earlierLabel} onClick={() => move(index, index - 1)}>
              <Icon name="chevron-left" size={16} />
            </Button>
            <Button variant="ghost" disabled={disabled || index === drafts.length - 1} aria-label={laterLabel} title={laterLabel} onClick={() => move(index, index + 1)}>
              <Icon name="chevron-right" size={16} />
            </Button>
            <Button variant="ghost" disabled={disabled} aria-label={removeLabel} title={removeLabel} onClick={() => remove(draft.key)}>
              <Icon name="x" size={16} />
            </Button>
          </div>
        </li>;
      })}
    </ol>}
  </section>;
}

export function ListingGallery({ images }: { images: ListingImage[] }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(images[0]?.id);
  const index = Math.max(0, images.findIndex(image => image.id === selected));
  const active = images[index];
  if (!active) return null;

  return <section className="listing-gallery" aria-label={t('Фотографии объявления')}>
    <div className="listing-gallery-stage">
      <ListingPhoto src={active.url} alt={t('Фото {number}', { number: index + 1 })} width={active.width} height={active.height} />
    </div>
    <div className="listing-gallery-caption">
      <span className="muted" role="status">{t('Фото {current} из {total}', { current: index + 1, total: images.length })}</span>
      <a href={active.url} target="_blank" rel="noreferrer">{t('Открыть фото в полном размере')}</a>
    </div>
    {images.length > 1 && <ol className="listing-gallery-thumbnails">
      {images.map((image, imageIndex) => <li key={image.id}>
        <button
          type="button"
          aria-label={t('Показать фото {number}', { number: imageIndex + 1 })}
          aria-pressed={image.id === active.id}
          onClick={() => setSelected(image.id)}
        >
          <ListingPhoto src={image.url} alt="" loading="lazy" />
        </button>
      </li>)}
    </ol>}
  </section>;
}
