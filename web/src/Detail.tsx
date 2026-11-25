import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from './api';
import type { User } from './api';
import { ListingVisual } from './Catalog';
import { StartChatButton } from './ChatPage';
import { useI18n } from './i18n';
import { categoryName, countryName, formatMoney, terms } from './market';
import type { Category, Listing } from './market';
import { Icon, Notice, Spinner } from './ui';

export function ListingDetail({ user }: { user: User | null }) {
  const { id } = useParams();
  const { t, locale } = useI18n();
  const [listing, setListing] = useState<Listing | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!user?.emailVerified || !id) return;
    const controller = new AbortController();
    setListing(null);
    setError('');
    void api<Listing>('/listings/' + encodeURIComponent(id), { signal: controller.signal }).then(setListing).catch((err: Error) => {
      if (controller.signal.aborted) return;
      const notFound = err instanceof ApiError && err.status === 404;
      setError(notFound ? 'Объявление не найдено или снято с публикации.' : err.message);
    });
    void api<Category[]>('/categories', { signal: controller.signal }).then(setCategories).catch(() => {});
    return () => controller.abort();
  }, [id, user?.id, user?.emailVerified]);
  const back = <Link className="back-link" to="/catalog"><Icon name="chevron-left" size={16} /> {t('К каталогу')}</Link>;
  if (!user?.emailVerified) return <div className="container detail-page">{back}<div className="panel locked-panel">
    <span className="lock-icon"><Icon name="lock-keyhole" size={25} /></span><h1>{t('Объявление доступно участникам')}</h1><p>{t('Войдите в аккаунт с подтверждённой почтой, чтобы увидеть условия сделки.')}</p>
    <div className="lock-actions"><Link className="button button-primary" to={`/login?next=${encodeURIComponent('/listings/' + id)}`}>{t('Войти')}</Link><Link className="button button-secondary" to={`/register?next=${encodeURIComponent('/listings/' + id)}`}>{t('Зарегистрироваться')}</Link></div>
  </div></div>;
  if (!listing) return <div className="container detail-page">{back}{error ? <Notice tone="error">{t(error)}</Notice> : <Spinner />}</div>;

  const category = listing.category ?? categories.find(item => item.id === listing.categoryId);
  const price = listing.price == null ? t('По договорённости') : (listing.kind === 'BUY' ? t('До {price}', {price: formatMoney(listing.price, listing.currency, locale)}) : formatMoney(listing.price, listing.currency, locale));
  const myListing = listing.owner.id === user.id;
  const compatible = (user.role === 'BUYER' && listing.kind === 'SELL') || (user.role === 'SELLER' && listing.kind === 'BUY');
  const companyOnly = listing.counterparty === 'COMPANY' && user.participantType !== 'COMPANY';
  const stringTerm = (value: string | null) => value ? t(terms[value] ?? value) : '';
  const localCountry = (value: string | null) => value ? countryName(value, locale) : '';
  const inclusion = (value: boolean) => t(value ? 'Включено' : 'Отдельно');
  const properties = [
    ['Количество', listing.quantity],
    ['Наличие', stringTerm(listing.availability)],
    ['Состояние', listing.condition === 'ANY' ? t('Любое') : stringTerm(listing.condition)],
    [listing.kind === 'BUY' ? 'Страна закупки' : listing.availability === 'STOCK' ? 'Страна склада' : 'Страна отгрузки', localCountry(listing.originCountry)],
    ['Город склада', listing.stockCity],
    ['Страна поставки', localCountry(listing.destinationCountry)],
    ['География закупки', stringTerm(listing.originScope)],
    [listing.kind === 'BUY' ? 'Поставка до' : 'Ориентировочная дата готовности', listing.deliveryBy ? new Intl.DateTimeFormat(locale, {dateStyle:'medium', timeZone:'UTC'}).format(new Date(listing.deliveryBy)) : ''],
    ['Доставка в стоимости', inclusion(listing.deliveryIncluded)],
    ['Таможня и пошлины в стоимости', inclusion(listing.customsIncluded)],
    ['НДС', stringTerm(listing.vat)],
    ['Контрагенты', t(listing.counterparty === 'COMPANY' ? 'Только компании' : 'Компании и частные лица')],
    ['Способы оплаты', listing.paymentMethods.map(stringTerm).join(', ')],
    ...Object.entries(listing.specs ?? {}),
  ];
  return <div className="container detail-page">
    {back}
    <div className="detail-title"><span className="listing-kicker">{category ? categoryName(category, locale) : t(listing.kind === 'SELL' ? 'Предложение' : 'Заявка на закупку')}</span><h1>{listing.title}</h1></div>
    <div className="detail-layout">
      <div className="detail-main">
        <ListingVisual listing={listing} category={category} />
        {listing.imageKey && <span className="illustration-note">{t('Иллюстрация оборудования')}</span>}
        <section className="panel detail-panel"><h2>{t('Описание')}</h2><p className="preserve-text">{listing.description}</p></section>
        <section className="panel detail-panel"><h2>{t('Условия сделки')}</h2><dl>
          {properties.filter(([,value]) => value !== null && value !== undefined && value !== '').map(([label, value]) => <div key={label}><dt>{t(String(label))}</dt><dd>{value}</dd></div>)}
        </dl></section>
      </div>
      <aside className="panel detail-panel detail-seller">
        <span className="muted">{t(listing.kind === 'SELL' ? 'Цена' : 'Бюджет')}</span>
        <strong className="detail-price">{price}</strong>
        <div className="detail-divider" />
        <div className="profile-inline"><span className="profile-avatar"><Icon name="user-round" size={21} /></span><div>
          <strong>{listing.owner.nickname ?? listing.owner.displayName}</strong><span>{listing.owner.city}{listing.owner.country ? ', ' + countryName(listing.owner.country, locale) : ''}</span>
        </div></div>
        <div className="reputation"><Icon name="star" size={16} /> {listing.owner.ratingCount > 0 && listing.owner.rating != null ?
          <span>{new Intl.NumberFormat(locale, {maximumFractionDigits:1}).format(listing.owner.rating)} · {t('Оценок: {count}', {count:listing.owner.ratingCount})}</span> : <span>{t('Пока без оценок')}</span>}</div>
        {myListing && ['ACTIVE','ARCHIVED'].includes(listing.status) && <Link className="button button-secondary" to={`/listings/${listing.id}/edit`}>{t('Редактировать')}</Link>}
        {compatible && listing.status === 'ACTIVE' && (companyOnly
          ? <p className="muted">{t('Автор принимает обращения только от компаний.')}</p>
          : <StartChatButton listingId={listing.id} />)}
      </aside>
    </div>
  </div>;
}
