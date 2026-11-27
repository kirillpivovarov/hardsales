import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, tradeSidesFor, type User } from './api';
import { useI18n } from './i18n';
import { ListingImagesEditor, listingImagePayload } from './ListingImages';
import type { ListingImageDraft } from './ListingImages';
import { useExchange } from './Exchange';
import { ListingModelFields } from './Models';
import { ListingRepresentationFields, readListingRepresentation } from './Representation';
import { StaffRepresentationFields, type StaffListingOwner } from './StaffListingFields';
import { PaymentTerms } from './Trust';
import locationData from '../../server/seeds/exchange_data/locations.json';
import paymentData from '../../server/seeds/exchange_data/payment_forms.json';
import { CountrySelect } from './CountrySelect';
import { categoryName, formatMoney, maxUnitPrice, type Category, type Listing } from './market';
import { Button, Field, Notice, Spinner } from './ui';
import './workflows.css';

type Kind = 'BUY' | 'SELL';

interface ListingFormProps {
  listingId?: string;
  admin?: boolean;
  kind?: Kind;
  homeCountry?: string;
  ownerId?: string;
  user?: User;
  staffOwner?: StaffListingOwner;
  onSaved: (listing: { id: string }) => void;
}

const paymentLabels = {
  BANK_TRANSFER: 'Банковский перевод',
  CARD: 'Карта',
  CASH: 'Наличные',
  LETTER_OF_CREDIT: 'Аккредитив',
};

function OptionalListingFields({ compact, title, children }: { compact: boolean; title: string; children: ReactNode }) {
  return compact ? <details className="workflow-span listing-more-fields">
    <summary>{title}</summary>
    <div className="form-grid workflow-form">{children}</div>
  </details> : <>{children}</>;
}

const currencyChoices = [
  ['RUB', 'Российский рубль'],
  ['USD', 'Доллар США'],
  ['EUR', 'Евро'],
  ['CNY', 'Китайский юань'],
  ['KZT', 'Казахстанский тенге'],
  ['AED', 'Дирхам ОАЭ'],
];

export function ListingEditorPage({ user }: { user: User }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useI18n();

  return (
    <div className="workflow-page container">
      <div className="workflow-intro">
        <p><Link to="/my-listings">{t('Мои объявления')}</Link></p>
        <h1>{t(id ? 'Редактирование объявления' : 'Новое объявление')}</h1>
      </div>
      <div className="workflow-editor">
        <ListingForm
          listingId={id}
          kind={user.role === 'BUYER' ? 'BUY' : 'SELL'}
          homeCountry={user.country}
          ownerId={user.id}
          user={user}
          onSaved={listing => navigate(`/listings/${listing.id}`)}
        />
      </div>
    </div>
  );
}

export function ListingForm(props: ListingFormProps) {
  const { listingId, admin, staffOwner } = props;
  const { t } = useI18n();
  const [state, setState] = useState<{ categories: Category[]; listing?: Listing; forListing: string }>();
  const [error, setError] = useState('');
  const key = String(listingId ?? 'new');
  const listingPath = listingId ? `/${admin ? 'admin/' : ''}listings/${listingId}`
    : staffOwner ? `/admin/users/${staffOwner.id}/listings` : '/listings';

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setError('');
    Promise.all([
      api<Category[]>(admin ? '/admin/categories' : '/categories', { signal }),
      listingId ? api<Listing>(listingPath, { signal }) : Promise.resolve(undefined),
    ]).then(([categories, listing]) => {
      if (!signal.aborted) setState({ categories, listing, forListing: key });
    }).catch(cause => {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить объявление.');
    });
    return () => controller.abort();
  }, [admin, listingId, listingPath, key]);

  if (error) return <Notice tone="error">{t(error)}</Notice>;
  if (!state || state.forListing !== key) return <Spinner />;
  if (state.listing && !admin && state.listing.owner.id !== props.ownerId) {
    return <Notice tone="error">{t('Редактировать объявление может только его автор.')}</Notice>;
  }
  if (!admin && (state.listing?.status === 'FROZEN' || state.listing?.status === 'BANNED' || state.listing?.status === 'HIDDEN')) {
    return <Notice tone="error">{t('Редактирование приостановлено модератором.')}</Notice>;
  }
  return <ListingFields key={key} {...props} categories={state.categories} listing={state.listing} listingPath={listingPath} />;
}

function ListingFields({
  listing,
  categories,
  listingPath,
  kind = 'SELL',
  homeCountry = 'RU',
  admin,
  user,
  staffOwner,
  onSaved,
}: ListingFormProps & { listing?: Listing; categories: Category[]; listingPath: string }) {
  const { t, locale } = useI18n();
  const { features } = useExchange();
  const [title, setTitle] = useState(listing?.title ?? '');
  const [modelSelection, setModelSelection] = useState({
    modelId: listing?.modelId ?? listing?.model?.id ?? null,
    analogModelIds: listing?.analogModelIds ?? [],
  });
  const [draftSpecs, setDraftSpecs] = useState<Record<string, string>>(listing?.specs ?? {});
  const sides = staffOwner ? staffOwner.tradeSides ?? [staffOwner.role === 'BUYER' ? 'BUY' : 'SELL'] : tradeSidesFor(user);
  const [selectedKind, setSelectedKind] = useState<Kind>(() => sides.includes(kind) ? kind : sides[0] ?? kind);
  const isBuyer = (listing?.kind ?? selectedKind) === 'BUY';
  const [categoryId, setCategoryId] = useState(listing?.categoryId ?? '');
  const [priceMode, setPriceMode] = useState<string>(listing?.priceMode ?? 'FIXED');
  const [price, setPrice] = useState(String(listing?.price ?? ''));
  const [quantity, setQuantity] = useState(String(listing?.quantity ?? 1));
  const [currency, setCurrency] = useState(listing?.currency ?? 'RUB');
  const [deliveryIncluded, setDeliveryIncluded] = useState(listing?.deliveryIncluded ?? false);
  const [priceWarning, setPriceWarning] = useState(false);
  const [availability, setAvailability] = useState(listing?.availability ?? 'STOCK');
  const [originScope, setOriginScope] = useState(listing?.originScope ?? 'ANY');
  const sellerDefaultCountry = listing?.originScope === 'ANY' ? 'ANY' : homeCountry;
  const defaultOriginCountry = listing?.originCountry ?? (isBuyer ? '' : sellerDefaultCountry);
  const [photoDraft, setPhotoDraft] = useState<ListingImageDraft[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState<{ field: string; message: string }>();
  const earliestDate = new Date().toISOString().slice(0, 10);
  const hasPreviousDate = listing?.deliveryBy && listing.deliveryBy < earliestDate;
  const photos = photoDraft ?? (listing?.images ?? []).map(image => ({ key: image.id, image }));
  const newPhotoKeys = photos.filter(photo => 'file' in photo).map(photo => photo.key).sort();
  const photoConfirmation = (features.feature_disclosure_journal === true || fieldError?.field === 'images') && newPhotoKeys.length > 0;
  const selectedCategory = categories.find(category => category.id === categoryId);
  const compact = Boolean(!listing && !staffOwner && !admin && selectedCategory?.requiresModel
    && features.feature_listing_premoderation === true);
  const attributes = [...new Set([
    ...(selectedCategory?.attributeKeys ?? []),
    ...(listing?.categoryId === categoryId ? Object.keys(listing?.specs ?? {}) : []),
  ])];
  const fieldHint = (name: string, hint?: string) => fieldError?.field === name
    ? <span role="alert" className="field-error">{t(fieldError.message)}</span> : (hint ? t(hint) : undefined);

  useEffect(() => {
    setPriceWarning(false);
    if (priceMode !== 'FIXED' || !modelSelection.modelId || !/^\d+(\.\d{1,2})?$/.test(price)
      || Number(price) <= 0 || Number(price) > maxUnitPrice
      || !/^\d+$/.test(quantity) || Number(quantity) <= 50 || Number(quantity) > 1_000_000) return;
    const controller = new AbortController();
    const parameters = new URLSearchParams({ price, quantity, currency, deliveryIncluded: String(deliveryIncluded) });
    const timer = window.setTimeout(() => {
      void api<{ looksLikeTotal: boolean }>(`/models/${encodeURIComponent(modelSelection.modelId!)}/price-check?${parameters}`,
        { signal: controller.signal }).then(result => {
          if (!controller.signal.aborted) setPriceWarning(result.looksLikeTotal);
        }).catch(() => undefined);
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [priceMode, modelSelection.modelId, price, quantity, currency, deliveryIncluded]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const element = event.currentTarget;
    const form = new FormData(element);
    setFieldError(undefined);
    const value = (name: string) => String(form.get(name) ?? '').trim();
    const sourceCountry = value('originCountry');
    const sellerScope = sourceCountry === 'ANY' ? 'ANY' : 'COUNTRY';
    const sourceScope = isBuyer ? originScope : sellerScope;
    const paymentMethods = form.getAll('paymentMethods');
    if (!paymentMethods.length) {
      setError('Выберите хотя бы один способ оплаты.');
      return;
    }

    const specs = Object.fromEntries(attributes
      .map(attribute => [attribute, value(`spec:${attribute}`)] as const)
      .filter(([, entry]) => entry));
    setError('');
    setBusy(true);
    try {
      const details = {
        title: value('title'),
        description: value('description'),
        categoryId,
        kind: isBuyer ? 'BUY' : 'SELL',
        quantity: Number(value('quantity')),
        condition: value('condition'),
        availability: isBuyer ? null : availability,
        stockCity: !isBuyer && availability === 'STOCK' ? value('stockCity') : null,
        originCountry: sourceScope === 'COUNTRY' ? sourceCountry : null,
        originScope: sourceScope,
        destinationCountry: value('destinationCountry') || null,
        deliveryBy: value('deliveryBy') || null,
        priceMode,
        price: priceMode === 'FIXED' ? Number(value('price')) : null,
        currency: value('currency'),
        deliveryIncluded: form.has('deliveryIncluded'),
        customsIncluded: form.has('customsIncluded'),
        vat: value('vat'),
        counterparty: value('counterparty'),
        paymentMethods,
        specs,
        ...(staffOwner && { staffSourceNote: value('staffSourceNote') }),
        ...(form.get('imageContactAcknowledged') === 'on' && { imageContactAcknowledged: true }),
        ...modelSelection,
        ...readListingRepresentation(form),
        ...(value('lifetimeDays') ? { lifetimeDays: Number(value('lifetimeDays')) } : {}),
        ...(value('minLot') ? { minLot: Number(value('minLot')) } : {}),
        ...(form.has('shipDays') ? { shipDays: value('shipDays') ? Number(value('shipDays')) : null } : {}),
        ...(features.feature_matching === true || features.feature_trust_rating === true ? { paymentTerms: form.getAll('paymentTerms') } : {}),
      };
      const saved = await api<{ id: string }>(listingPath, {
        method: listing ? 'PATCH' : 'POST',
        body: listingImagePayload(details, photoDraft, listing?.images),
      });
      onSaved(saved);
    } catch (cause) {
      if (cause instanceof ApiError && cause.field && ['CONTACT_IN_FIELD', 'PHOTO_CONTACT_CONFIRMATION_REQUIRED', 'MODEL_REQUIRED'].includes(cause.code ?? '')) {
        const control = element.elements.namedItem(cause.field === 'images' ? 'imageContactAcknowledged' : cause.field);
        if (control instanceof HTMLElement) {
          const group = control.closest('details');
          if (group) group.open = true;
          control.focus();
        }
        setFieldError({ field: cause.field, message: cause.message });
      } else {
        setError(cause instanceof Error ? cause.message : 'Не удалось сохранить объявление.');
      }
    } finally {
      setBusy(false);
    }
  }

  const titleField = (
    <div className="workflow-span">
      <Field label={t('Заголовок')} hint={fieldHint('title')}>
        <input name="title" aria-invalid={fieldError?.field === 'title'} value={title} onChange={event => setTitle(event.target.value)} placeholder={t('Например, сервер с 4 × NVIDIA H100')} minLength={3} maxLength={140} required={!compact} />
      </Field>
    </div>
  );

  return (
    <form className="workflow-stack" onSubmit={submit} aria-busy={busy} onInvalid={event => {
      if (event.target instanceof HTMLElement) {
        const group = event.target.closest('details');
        if (group) group.open = true;
      }
    }}>
      {!listing && sides.length === 2 && <section className="panel workflow-section">
        <Field label={t('Что размещаете?')}>
          <select name="kind" value={selectedKind} onChange={event => {
            setSelectedKind(event.target.value as Kind);
            setModelSelection({ modelId: null, analogModelIds: [] });
          }}>
            <option value="SELL">{t('Предложение (продаю)')}</option>
            <option value="BUY">{t('Заявка (покупаю)')}</option>
          </select>
        </Field>
      </section>}
      {user && <ListingRepresentationFields user={user} listing={listing} />}
      {staffOwner && <>
        <Field label={t('Откуда данные')} hint={t('Заметка доступна сотрудникам.')}>
          <textarea name="staffSourceNote" minLength={5} maxLength={500} rows={2} required />
        </Field>
        <StaffRepresentationFields owner={staffOwner} />
      </>}
      <section className="panel workflow-section">
        <h2>{t(isBuyer ? 'Какое оборудование нужно' : 'Какое оборудование продаётся')}</h2>
        <div className="form-grid workflow-form">
          {!compact && titleField}
          <div className="workflow-span">
            <Field label={t('Категория')}>
              <select name="categoryId" value={categoryId} onChange={event => {
                setCategoryId(event.target.value); setModelSelection({ modelId: null, analogModelIds: [] }); setDraftSpecs({});
              }} required>
                <option value="">{t('Выберите категорию')}</option>
                {categories.filter(category => category.active || category.id === listing?.categoryId).map(category => {
                  const parent = categories.find(item => item.id === category.parentId);
                  const name = categoryName(category, locale);
                  return <option key={category.id} value={category.id}>{parent ? `${categoryName(parent, locale)} / ${name}` : name}</option>;
                })}
              </select>
            </Field>
          </div>
          {selectedCategory && <div className="workflow-span">
            <ListingModelFields categorySlug={selectedCategory.slug} title={title} buyer={isBuyer} canPropose={!admin && !staffOwner}
              required={selectedCategory.requiresModel} errorMessage={fieldError?.field === 'modelId' ? fieldError.message : undefined}
              {...modelSelection} onChange={value => {
                setModelSelection(value);
                setFieldError(current => current?.field === 'modelId' ? undefined : current);
              }} onSelectModel={model => setDraftSpecs(current => {
                const values: Record<string, string> = {
                  'Модель': model.nameEn, 'Видеопамять': model.memoryGb ? model.memoryGb + ' ГБ' : '',
                  'Форм-фактор': model.formFactor ?? '', 'Количество GPU': model.gpuCount ? String(model.gpuCount) : '',
                };
                return { ...current, ...Object.fromEntries(attributes.filter(key => !current[key] && values[key]).map(key => [key, values[key]])) };
              })} />
          </div>}
          <Field label={t('Количество, шт.')}>
            <input name="quantity" type="number" min={1} max={1_000_000} value={quantity} onChange={event => setQuantity(event.target.value)} required />
          </Field>
          <OptionalListingFields compact={compact} title={t('Описание и характеристики')}>
          {compact && titleField}
          {features.feature_matching === true && <Field label={t('Минимальная партия, шт.')}>
            <input name="minLot" type="number" min={1} max={1_000_000} defaultValue={listing?.minLot ?? 1} required />
          </Field>}
          <Field label={t('Состояние')}>
            <select name="condition" defaultValue={listing?.condition ?? (isBuyer ? 'ANY' : 'NEW')}>
              {isBuyer && <option value="ANY">{t('Любое')}</option>}
              <option value="NEW">{t('Новое')}</option>
              <option value="USED">{t('Б/у')}</option>
              <option value="REFURBISHED">{t('Восстановленное')}</option>
            </select>
          </Field>
          <div className="workflow-span">
            <Field label={t('Описание')} hint={fieldHint('description', 'Укажите модель, конфигурацию и комплектацию. Для общения используйте чат.')}>
              <textarea name="description" aria-invalid={fieldError?.field === 'description'} defaultValue={listing?.description} minLength={10} maxLength={8000} required={!compact} />
            </Field>
          </div>
          {attributes.map(attribute => (
            <Field key={`${categoryId}-${attribute}`} label={t(attribute)} hint={fieldHint(`spec:${attribute}`)}>
              <input name={`spec:${attribute}`} aria-invalid={fieldError?.field === `spec:${attribute}`} value={draftSpecs[attribute] ?? ''} onChange={event => setDraftSpecs(values => ({ ...values, [attribute]: event.target.value }))} maxLength={300} />
            </Field>
          ))}
          </OptionalListingFields>
        </div>
      </section>
      <OptionalListingFields compact={compact} title={t('Фотографии')}>
      <ListingImagesEditor drafts={photos} onChange={setPhotoDraft} disabled={busy} />
      {photoConfirmation && <div>
        <label className="workflow-checkbox">
          <input key={newPhotoKeys.join(',')} type="checkbox" name="imageContactAcknowledged" required />
          {t('На фото нет контактов')}
        </label>
        {fieldHint('images')}
      </div>}
      </OptionalListingFields>
      <section className="panel workflow-section">
        <h2>{t('Сроки и география')}</h2>
        <div className="form-grid workflow-form">
          {isBuyer ? (
            <>
              <Field label={t('Откуда нужна поставка')}>
                <select name="originScope" value={originScope} onChange={event => setOriginScope(event.target.value)}>
                  <option value="ANY">{t('Из любой страны')}</option>
                  <option value="DOMESTIC">{t('Внутри страны доставки')}</option>
                  <option value="COUNTRY">{t('Из конкретной страны')}</option>
                </select>
              </Field>
              <CountrySelect label={t('Страна доставки')} name="destinationCountry" defaultValue={listing?.destinationCountry ?? homeCountry} required />
            </>
          ) : (
            <Field label={t('Наличие')}>
              <select name="availability" value={availability} onChange={event => setAvailability(event.target.value)}>
                <option value="STOCK">{t('На складе')}</option>
                <option value="TRANSIT">{t('В пути')}</option>
                <option value="ORDER">{t('Под заказ')}</option>
              </select>
            </Field>
          )}
          {(!isBuyer || originScope === 'COUNTRY') && (
            <CountrySelect
              label={t(isBuyer ? 'Страна происхождения поставки' : 'Страна отгрузки')}
              name="originCountry" defaultValue={defaultOriginCountry} required
              leading={isBuyer ? undefined : [{ value: 'ANY', label: t('Из любой страны') }]}
            />
          )}
          {!isBuyer && availability === 'STOCK' && (
            <Field label={t('Город склада')} hint={fieldHint('stockCity', 'Если складов несколько, укажите основной город.')}>
              <input name="stockCity" aria-invalid={fieldError?.field === 'stockCity'} list="exchange-stock-cities" defaultValue={listing?.stockCity ?? ''} minLength={2} maxLength={120} required />
              <datalist id="exchange-stock-cities">{locationData.locations.map(place =>
                <option key={place.id} value={locale.startsWith('ru') ? place.city_ru : place.city_en} />)}</datalist>
            </Field>
          )}
          <OptionalListingFields compact={compact} title={t('Сроки и условия поставки')}>
          {!isBuyer && (
            <CountrySelect
              label={t('Страна доставки')} name="destinationCountry" defaultValue={listing?.destinationCountry ?? ''}
              leading={[{ value: '', label: t('По договорённости') }]}
              hint={t('Можно оставить пустым, чтобы обсудить географию поставок в чате.')}
            />
          )}
          {features.feature_actuality === true && <Field label={t('Срок показа, дней')}
            hint={t('Актуальность объявления нужно подтверждать ежедневно.')}>
            <input name="lifetimeDays" type="number" min={1} max={60} defaultValue={listing?.lifetimeDays ?? (isBuyer ? 21 : 14)} required />
          </Field>}
          {!isBuyer && features.feature_matching === true && <Field label={t('Отгрузка в течение, дней')}>
            <input name="shipDays" type="number" min={0} max={365} defaultValue={listing?.shipDays ?? ''} />
          </Field>}
          <Field label={t(isBuyer ? 'Требуется доставка до' : 'Предложение действительно до')}
            hint={isBuyer ? undefined : t('Если указать дату, предложение будет видно в каталоге до конца этого дня по UTC.')}>
            <input name="deliveryBy" type="date" min={hasPreviousDate ? undefined : earliestDate} defaultValue={listing?.deliveryBy?.slice(0, 10)} required={isBuyer && !compact} />
          </Field>
          </OptionalListingFields>
        </div>
      </section>
      <section className="panel workflow-section">
        <h2>{t('Цена и оплата')}</h2>
        <div className="form-grid workflow-form">
          <Field label={t('Условия цены')}>
            <select name="priceMode" value={priceMode} onChange={event => setPriceMode(event.target.value)}>
              <option value="FIXED">{t(isBuyer ? 'Максимальный бюджет' : 'Указана цена')}</option>
              <option value="NEGOTIABLE">{t('По договорённости')}</option>
            </select>
          </Field>
          <Field label={t('Валюта')}>
            <select name="currency" value={currency} onChange={event => setCurrency(event.target.value)}>
              {currencyChoices.map(([code, label]) => <option key={code} value={code}>{code} · {t(label)}</option>)}
            </select>
          </Field>
          {priceMode === 'FIXED' && <div>
            <Field label={t(isBuyer ? 'Бюджет за шт., до' : 'Цена за шт.')} hint={t('Цена за одну единицу. Общая сумма считается сама.')}>
              <input name="price" type="number" min="0.01" step="0.01" max={maxUnitPrice} value={price}
                onChange={event => setPrice(event.target.value)} required />
            </Field>
            {Number(price) > 0 && Number(quantity) > 1 && <p className="muted">
              {t('За {quantity} шт.: {price}', { quantity, price: formatMoney(Number(price) * Number(quantity), currency, locale) })}
            </p>}
            {priceWarning && <p role="status">
              {t('Похоже, вы указали сумму за всё количество. Здесь нужна цена за одну штуку.')}
            </p>}
          </div>}
          <OptionalListingFields compact={compact} title={t('Подробнее об условиях')}>
          <Field label={t('НДС')}>
            <select name="vat" defaultValue={listing?.vat ?? 'NA'}>
              <option value="INCLUDED">{t('Включён')}</option>
              <option value="EXCLUDED">{t('Сверх цены')}</option>
              <option value="NA">{t('Не применяется')}</option>
            </select>
          </Field>
          <Field label={t(isBuyer ? 'У кого готовы покупать' : 'Кому готовы продавать')}>
            <select name="counterparty" defaultValue={listing?.counterparty ?? 'ANY'}>
              <option value="ANY">{t('Компании и частные лица')}</option>
              <option value="COMPANY">{t('Только компании')}</option>
            </select>
          </Field>
          <fieldset className="workflow-span workflow-checks">
            <legend>{t('Что входит в сумму')}</legend>
            <div className="workflow-checkbox-list">
              <label className="workflow-checkbox">
                <input type="checkbox" name="deliveryIncluded" checked={deliveryIncluded} onChange={event => setDeliveryIncluded(event.target.checked)} /> {t('Доставка')}
              </label>
              <label className="workflow-checkbox">
                <input type="checkbox" name="customsIncluded" defaultChecked={listing?.customsIncluded ?? false} /> {t('Таможенное оформление и пошлины')}
              </label>
            </div>
          </fieldset>
          <fieldset className="workflow-span workflow-checks">
            <legend>{t('Способы оплаты')}</legend>
            <div className="workflow-checkbox-list">
              {Object.entries(paymentLabels).map(([method, label]) => (
                <label key={method} className="workflow-checkbox">
                  <input type="checkbox" name="paymentMethods" value={method} defaultChecked={listing ? listing.paymentMethods.includes(method) : method === 'BANK_TRANSFER'} />
                  {t(label)}
                </label>
              ))}
            </div>
          </fieldset>
          </OptionalListingFields>
        </div>
      </section>
      <OptionalListingFields compact={compact} title={t('Расчёты')}>
      {features.feature_trust_rating === true && <PaymentTerms selected={listing?.paymentTerms} />}
      {features.feature_matching === true && features.feature_trust_rating !== true && <fieldset className="panel workflow-section">
        <legend>{t('Условия расчёта')}</legend>
        <div className="form-grid">
          {paymentData.payment_terms.map(term => <label className="admin-check" key={term.code}>
            <input type="checkbox" name="paymentTerms" value={term.code} defaultChecked={listing?.paymentTerms?.includes(term.code)} />
            {t(term.label_ru)}
          </label>)}
        </div>
      </fieldset>}
      </OptionalListingFields>
      {error && <Notice tone="error">{t(error)}</Notice>}
      <div className="workflow-actions">
        <Button type="submit" disabled={busy}>{t(busy ? 'Сохраняем объявление…' : staffOwner ? 'Отправить черновик владельцу' :
          listing?.status === 'PENDING_OWNER' && !admin ? 'Сохранить и подтвердить объявление' : listing ? 'Сохранить изменения' : 'Опубликовать объявление')}</Button>
      </div>
    </form>
  );
}
