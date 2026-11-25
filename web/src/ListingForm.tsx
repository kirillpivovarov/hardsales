import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type User } from './api';
import { useI18n } from './i18n';
import { categoryName, countries, countryName, type Category, type Listing } from './market';
import { Button, Field, Notice, Spinner } from './ui';
import './workflows.css';

type Kind = 'BUY' | 'SELL';

interface ListingFormProps {
  listingId?: string;
  admin?: boolean;
  kind?: Kind;
  homeCountry?: string;
  ownerId?: string;
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
  if (!admin && (state.listing?.status === 'FROZEN' || state.listing?.status === 'BANNED')) {
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
  onSaved,
}: ListingFormProps & { listing?: Listing; categories: Category[]; listingPath: string }) {
  const { t, locale } = useI18n();
  const isBuyer = (listing?.kind ?? kind) === 'BUY';
  const [categoryId, setCategoryId] = useState(listing?.categoryId ?? '');
  const [priceMode, setPriceMode] = useState<string>(listing?.priceMode ?? 'FIXED');
  const [availability, setAvailability] = useState(listing?.availability ?? 'STOCK');
  const [originScope, setOriginScope] = useState(listing?.originScope ?? 'ANY');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const earliestDate = new Date().toISOString().slice(0, 10);
  const hasPreviousDate = listing?.deliveryBy && listing.deliveryBy < earliestDate;
  const selectedCategory = categories.find(category => category.id === categoryId);
  const attributes = [...new Set([
    ...(selectedCategory?.attributeKeys ?? []),
    ...(listing?.categoryId === categoryId ? Object.keys(listing?.specs ?? {}) : []),
  ])];

  const countryOptions = useMemo(() => countries.map(code => ({
    code, label: countryName(code, locale),
  })).sort((a, b) => a.label.localeCompare(b.label, locale)), [locale]);
  const countryChoices = countryOptions.map(({ code, label }) => <option key={code} value={code}>{label}</option>);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? '').trim();
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
      const saved = await api<{ id: string }>(listingPath, {
        method: listing ? 'PATCH' : 'POST',
        body: {
          title: value('title'),
          description: value('description'),
          categoryId,
          kind: isBuyer ? 'BUY' : 'SELL',
          quantity: Number(value('quantity')),
          condition: value('condition'),
          availability: isBuyer ? null : availability,
          stockCity: !isBuyer && availability === 'STOCK' ? value('stockCity') : null,
          originCountry: !isBuyer || originScope === 'COUNTRY' ? value('originCountry') : null,
          originScope: isBuyer ? originScope : null,
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
        },
      });
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить объявление.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="workflow-stack" onSubmit={submit} aria-busy={busy}>
      <section className="panel workflow-section">
        <h2>{t(isBuyer ? 'Какое оборудование нужно' : 'Какое оборудование продаётся')}</h2>
        <div className="form-grid workflow-form">
          <div className="workflow-span">
            <Field label={t('Заголовок')}>
              <input name="title" defaultValue={listing?.title} placeholder={t('Например, сервер с 4 × NVIDIA H100')} minLength={3} maxLength={140} required />
            </Field>
          </div>
          <div className="workflow-span">
            <Field label={t('Категория')}>
              <select name="categoryId" value={categoryId} onChange={event => setCategoryId(event.target.value)} required>
                <option value="">{t('Выберите категорию')}</option>
                {categories.filter(category => category.active || category.id === listing?.categoryId).map(category => {
                  const parent = categories.find(item => item.id === category.parentId);
                  const name = categoryName(category, locale);
                  return <option key={category.id} value={category.id}>{parent ? `${categoryName(parent, locale)} / ${name}` : name}</option>;
                })}
              </select>
            </Field>
          </div>
          <Field label={t('Количество, шт.')}>
            <input name="quantity" type="number" min={1} max={1_000_000} defaultValue={listing?.quantity ?? 1} required />
          </Field>
          <Field label={t('Состояние')}>
            <select name="condition" defaultValue={listing?.condition ?? (isBuyer ? 'ANY' : 'NEW')}>
              {isBuyer && <option value="ANY">{t('Любое')}</option>}
              <option value="NEW">{t('Новое')}</option>
              <option value="USED">{t('Б/у')}</option>
              <option value="REFURBISHED">{t('Восстановленное')}</option>
            </select>
          </Field>
          <div className="workflow-span">
            <Field label={t('Описание')} hint={t('Укажите модель, конфигурацию и комплектацию. Для общения используйте чат.')}>
              <textarea name="description" defaultValue={listing?.description} minLength={10} maxLength={8000} required />
            </Field>
          </div>
          {attributes.map(attribute => (
            <Field key={`${categoryId}-${attribute}`} label={t(attribute)}>
              <input name={`spec:${attribute}`} defaultValue={listing?.categoryId === categoryId ? listing.specs?.[attribute] : undefined} maxLength={300} />
            </Field>
          ))}
        </div>
      </section>
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
              <Field label={t('Страна доставки')}>
                <select name="destinationCountry" defaultValue={listing?.destinationCountry ?? homeCountry} required>{countryChoices}</select>
              </Field>
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
            <Field label={t(isBuyer ? 'Страна происхождения поставки' : availability === 'STOCK' ? 'Страна склада' : 'Страна отгрузки')}>
              <select name="originCountry" defaultValue={listing?.originCountry ?? (isBuyer ? '' : homeCountry)} required>
                <option value="">{t('Выберите страну')}</option>
                {countryChoices}
              </select>
            </Field>
          )}
          {!isBuyer && availability === 'STOCK' && (
            <Field label={t('Город склада')}>
              <input name="stockCity" defaultValue={listing?.stockCity ?? ''} minLength={2} maxLength={120} required />
            </Field>
          )}
          {!isBuyer && (
            <Field label={t('Страна доставки')} hint={t('Можно оставить пустым, чтобы обсудить географию поставок в чате.')}>
              <select name="destinationCountry" defaultValue={listing?.destinationCountry ?? ''}>
                <option value="">{t('По договорённости')}</option>
                {countryChoices}
              </select>
            </Field>
          )}
          <Field label={t(isBuyer ? 'Требуется доставка до' : 'Ориентировочная дата готовности')}>
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
      {error && <Notice tone="error">{t(error)}</Notice>}
      <div className="workflow-actions">
        <Button type="submit" disabled={busy}>{t(listing ? 'Сохранить изменения' : 'Опубликовать объявление')}</Button>
      </div>
    </form>
  );
}
