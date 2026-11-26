import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type User } from './api';
import { useI18n } from './i18n';
import { ListingImagesEditor, listingImagePayload } from './ListingImages';
import type { ListingImageDraft } from './ListingImages';
import { useExchange } from './Exchange';
import { ListingModelFields } from './Models';
import { ListingRepresentationFields, readListingRepresentation } from './Representation';
import { PaymentTerms } from './Trust';
import locationData from '../../server/seeds/exchange_data/locations.json';
import paymentData from '../../server/seeds/exchange_data/payment_forms.json';
import { CountrySelect } from './CountrySelect';
import { categoryName, type Category, type Listing } from './market';
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
  onSaved: (listing: { id: string }) => void;
}

const paymentLabels = {
  BANK_TRANSFER: 'Банковский перевод',
  CARD: 'Карта',
  CASH: 'Наличные',
  LETTER_OF_CREDIT: 'Аккредитив',
};

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
  const { listingId, admin } = props;
  const { t } = useI18n();
  const [state, setState] = useState<{ categories: Category[]; listing?: Listing; forListing: string }>();
  const [error, setError] = useState('');
  const key = String(listingId ?? 'new');
  const listingPath = listingId ? `/${admin ? 'admin/' : ''}listings/${listingId}` : '/listings';

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
  const isBuyer = (listing?.kind ?? kind) === 'BUY';
  const [categoryId, setCategoryId] = useState(listing?.categoryId ?? '');
  const [priceMode, setPriceMode] = useState<string>(listing?.priceMode ?? 'FIXED');
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
  const attributes = [...new Set([
    ...(selectedCategory?.attributeKeys ?? []),
    ...(listing?.categoryId === categoryId ? Object.keys(listing?.specs ?? {}) : []),
  ])];
  const fieldHint = (name: string, hint?: string) => fieldError?.field === name
    ? <span role="alert" className="field-error">{t(fieldError.message)}</span> : (hint ? t(hint) : undefined);

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
      if (cause instanceof ApiError && cause.field && ['CONTACT_IN_FIELD', 'PHOTO_CONTACT_CONFIRMATION_REQUIRED'].includes(cause.code ?? '')) {
        const control = element.elements.namedItem(cause.field === 'images' ? 'imageContactAcknowledged' : cause.field);
        if (control instanceof HTMLElement) control.focus();
        setFieldError({ field: cause.field, message: cause.message });
      } else {
        setError(cause instanceof Error ? cause.message : 'Не удалось сохранить объявление.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="workflow-stack" onSubmit={submit} aria-busy={busy}>
      {user && <ListingRepresentationFields user={user} listing={listing} />}
      <section className="panel workflow-section">
        <h2>{t(isBuyer ? 'Какое оборудование нужно' : 'Какое оборудование продаётся')}</h2>
        <div className="form-grid workflow-form">
          <div className="workflow-span">
            <Field label={t('Заголовок')} hint={fieldHint('title')}>
              <input name="title" aria-invalid={fieldError?.field === 'title'} value={title} onChange={event => setTitle(event.target.value)} placeholder={t('Например, сервер с 4 × NVIDIA H100')} minLength={3} maxLength={140} required />
            </Field>
          </div>
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
            <ListingModelFields categorySlug={selectedCategory.slug} title={title} buyer={isBuyer} canPropose={!admin}
              {...modelSelection} onChange={setModelSelection} onSelectModel={model => setDraftSpecs(current => {
                const values: Record<string, string> = {
                  'Модель': model.nameEn, 'Видеопамять': model.memoryGb ? model.memoryGb + ' ГБ' : '',
                  'Форм-фактор': model.formFactor ?? '', 'Количество GPU': model.gpuCount ? String(model.gpuCount) : '',
                };
                return { ...current, ...Object.fromEntries(attributes.filter(key => !current[key] && values[key]).map(key => [key, values[key]])) };
              })} />
          </div>}
          <Field label={t('Количество, шт.')}>
            <input name="quantity" type="number" min={1} max={1_000_000} defaultValue={listing?.quantity ?? 1} required />
          </Field>
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
              <textarea name="description" aria-invalid={fieldError?.field === 'description'} defaultValue={listing?.description} minLength={10} maxLength={8000} required />
            </Field>
          </div>
          {attributes.map(attribute => (
            <Field key={`${categoryId}-${attribute}`} label={t(attribute)} hint={fieldHint(`spec:${attribute}`)}>
              <input name={`spec:${attribute}`} aria-invalid={fieldError?.field === `spec:${attribute}`} value={draftSpecs[attribute] ?? ''} onChange={event => setDraftSpecs(values => ({ ...values, [attribute]: event.target.value }))} maxLength={300} />
            </Field>
          ))}
        </div>
      </section>
      <ListingImagesEditor drafts={photos} onChange={setPhotoDraft} disabled={busy} />
      {photoConfirmation && <div>
        <label className="workflow-checkbox">
          <input key={newPhotoKeys.join(',')} type="checkbox" name="imageContactAcknowledged" required />
          {t('На фото нет контактов')}
        </label>
        {fieldHint('images')}
      </div>}
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
            <input name="deliveryBy" type="date" min={hasPreviousDate ? undefined : earliestDate} defaultValue={listing?.deliveryBy?.slice(0, 10)} required={isBuyer} />
          </Field>
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
            <select name="currency" defaultValue={listing?.currency ?? 'RUB'}>
              {currencyChoices.map(([code, label]) => <option key={code} value={code}>{code} · {t(label)}</option>)}
            </select>
          </Field>
          {priceMode === 'FIXED' && <Field label={t(isBuyer ? 'Бюджет до' : 'Цена')} hint={t('Укажите сумму за всё количество.')}>
            <input name="price" type="number" min="0.01" step="0.01" max={9_999_999_999_999.99} defaultValue={listing?.price ?? ''} required />
          </Field>}
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
                <input type="checkbox" name="deliveryIncluded" defaultChecked={listing?.deliveryIncluded ?? false} /> {t('Доставка')}
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
        </div>
      </section>
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
      {error && <Notice tone="error">{t(error)}</Notice>}
      <div className="workflow-actions">
        <Button type="submit" disabled={busy}>{t(busy ? 'Сохраняем объявление…' : listing ? 'Сохранить изменения' : 'Опубликовать объявление')}</Button>
      </div>
    </form>
  );
}
