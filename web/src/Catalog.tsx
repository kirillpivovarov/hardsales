import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, isStaff } from './api';
import type { User } from './api';
import { ActualityBadges } from './ActualityWidgets';
import { useExchange } from './Exchange';
import { CatalogModelFilter } from './Models';
import { ListingExchangeBadges } from './ListingExchangeBadges';
import { LotAlternatives } from './LotGroups';
import { useI18n } from './i18n';
import { ListingPhoto } from './ListingImages';
import { CountrySelect } from './CountrySelect';
import { categoryIcon, categoryName, countryName, formatMoney, terms } from './market';
import type { Category, Listing } from './market';
import { Button, Field, Icon, Notice, Spinner } from './ui';
import './market-design.css';

interface Results {
  items: Listing[];
  total: number;
  page: number;
  limit: number;
  locked: boolean;
  hiddenLowRating?: number;
}

const emptyResults: Results = { items: [], total: 0, page: 1, limit: 12, locked: false };

export function CatalogPage({ user, home = false }: { user: User | null; home?: boolean }) {
  const { t, locale } = useI18n();
  const { features } = useExchange();
  const [query, setQuery] = useSearchParams();
  const committedSearch = query.get('q') ?? '';
  const [search, setSearch] = useState(committedSearch);
  const sort = query.get('sort') ?? (committedSearch.trim() ? 'relevance' : features.feature_trust_rating === true ? 'trust' : 'newest');
  const [categoryResults, setCategoryResults] = useState<Category[]>();
  const [listingResults, setListingResults] = useState<{ source: string; data: Results }>();
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const oppositeKind = user?.role === 'SELLER' ? 'BUY' : user?.role === 'BUYER' ? 'SELL' : null;
  const kind = oppositeKind ?? (query.get('kind') === 'BUY' ? 'BUY' : 'SELL');
  const selectedCategory = query.get('category') ?? '';
  const selectedOrigin = query.get('country') ?? '';
  const originScope = query.get('originScope') ?? '';
  const showFlexibleOriginHint = /^[A-Z]{2}$/.test(selectedOrigin) && (kind === 'SELL' || !originScope || originScope === 'ANY');
  const destination = query.get('destinationCountry') ?? '';
  const priceMin = query.get('priceMin') ?? '';
  const priceMax = query.get('priceMax') ?? '';
  const currency = query.get('currency') || (priceMin || priceMax ? 'RUB' : '');
  const authenticated = Boolean(user?.emailVerified && !user.mustChangePassword);
  const staff = authenticated && isStaff(user);
  const requestedQuery = query.toString();
  const source = JSON.stringify([requestedQuery, kind, user?.id, authenticated]);
  const results = listingResults?.source === source ? listingResults.data : emptyResults;
  const busy = listingResults?.source !== source;
  const locked = !authenticated || results.locked;
  const categories = categoryResults ?? [];
  const unavailableCategory = selectedCategory && categoryResults && !categories.some(category => category.slug === selectedCategory);
  useEffect(() => { setSearch(committedSearch); }, [committedSearch]);
  useEffect(() => {
    const controller = new AbortController();
    void api<Category[]>('/categories', { signal: controller.signal }).then(items => {
      if (!controller.signal.aborted) setCategoryResults(items);
    }).catch(() => {});
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    const params = new URLSearchParams(requestedQuery);
    params.set('kind', kind);
    if (kind === 'BUY') params.delete('availability');
    else params.delete('originScope');
    api<Results>('/listings?' + params.toString(), { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setListingResults({ source, data });
    }).catch((caught: Error) => {
      if (controller.signal.aborted) return;
      setError(caught.message);
    });
    return () => controller.abort();
  }, [requestedQuery, kind, source, retry]);

  function change(values: Record<string,string>) {
    const next = new URLSearchParams(query);
    if (!('page' in values)) next.delete('page');
    if ('category' in values && values.category !== selectedCategory) {
      next.delete('model');
      next.delete('withAnalogs');
    }
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    setQuery(next, { preventScrollReset: true });
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    change({ q: search.trim() });
    document.getElementById('catalog')?.scrollIntoView({ block: 'start' });
  }

  const categoryTiles = categories.filter(category => !category.parentId).slice(0, 6);
  const options = (values: string[]) => values.map(value => <option value={value} key={value}>{t(terms[value] ?? value)}</option>);
  const allFilters = ['model','withAnalogs','representation','principalConfirmed','showAll','category','country','destinationCountry','ownerType','availability','condition','originScope','priceMode','counterparty','paymentMethod','priceMin','priceMax','currency','vat','deliveryIncluded','customsIncluded'];
  const filterCount = allFilters.filter(key => query.has(key)).length;
  const resultPages = Math.ceil(results.total / results.limit);
  const returnTarget = `?next=${encodeURIComponent('/catalog' + (requestedQuery ? '?' + requestedQuery : ''))}`;
  const catalogReturn = `${home ? '/' : '/catalog'}${requestedQuery ? '?' + requestedQuery : ''}#catalog`;
  const searchBar = <form className={home ? 'hero-search' : 'catalog-search'} onSubmit={submitSearch} role="search">
    <Icon name="search" size={20} />
    <input aria-label={t('Поиск оборудования')} placeholder={t(home ? 'Например, NVIDIA H100 или Dell R760' : 'Название, модель или спецификация')}
      value={search} onChange={event => setSearch(event.target.value)} name="q" maxLength={150} spellCheck={false} />
    <Button type="submit">{t('Найти')}</Button>
  </form>;
  const categoryShortcuts = categoryTiles.length > 0 && <section className="categories-section" aria-labelledby="category-title">
    <div className="section-heading"><h2 id="category-title">{t('Категории')}</h2><a className="text-link" href="#catalog" onClick={() => change({category:''})}>{t('Все категории')} <Icon name="chevron-down" size={16} /></a></div>
    <div className="category-grid">
      {categoryTiles.map(category => (
        <button type="button" key={category.id} className={'category-tile' + (category.slug === selectedCategory ? ' selected' : '')} aria-pressed={category.slug === selectedCategory}
          onClick={() => { change({ category: category.slug === selectedCategory ? '' : category.slug }); document.getElementById('catalog')?.scrollIntoView(); }}>
          <span className="category-icon"><Icon name={categoryIcon(category)} size={20} /></span>
          <span>{categoryName(category, locale, true)}</span>
        </button>
      ))}
    </div>
  </section>;

  return <div className="container market-page">
    {home && <section className="market-hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <h1 id="hero-title">{t('Железо для ИИ')}</h1>
        <p className="hero-description">{t('GPU, серверы и комплектующие')}</p>
      </div>
      {searchBar}
    </section>}
    {home && categoryShortcuts}
    <section className="catalog" id="catalog" aria-labelledby="catalog-title">
      <div className="section-heading catalog-heading">
        {home ? <h2 id="catalog-title">{t('Каталог оборудования')}</h2> : <h1 id="catalog-title">{t('Каталог оборудования')}</h1>}
        <div className="catalog-heading-actions">
          {!locked && !busy && !error && <span className="count-meta">{t('Найдено · {count}', { count: results.total })}</span>}
          {staff && <Link className="text-link" to="/admin?section=categories">{t('Управление категориями')}</Link>}
        </div>
      </div>
      {!home && <>{searchBar}{categoryShortcuts}</>}
      <div className="catalog-layout">
        <button type="button" className="button button-secondary mobile-filters" onClick={() => setFiltersOpen(!filtersOpen)} aria-expanded={filtersOpen} aria-controls="catalog-filters">
          <Icon name="list-filter" /> {t('Фильтры')}{filterCount ? ` · ${filterCount}` : ''}<Icon name={filtersOpen ? 'chevron-up' : 'chevron-down'} size={16} />
        </button>
        <aside className={'filters panel' + (filtersOpen ? ' filters-open' : '')} id="catalog-filters" aria-label={t('Фильтры каталога')}>
          <div className="filters-heading"><strong><Icon name="sliders-horizontal" size={17} /> {t('Фильтры')}</strong>
            {filterCount > 0 && <button type="button" className="text-link" onClick={() => change(Object.fromEntries(allFilters.map(key => [key, ''])))}>{t('Сбросить')}</button>}
          </div>
          <Field label={t('Категория')}><select value={selectedCategory} onChange={event => change({category:event.target.value})}>
            <option value="">{t('Все категории')}</option>
            {unavailableCategory && <option value={selectedCategory} disabled>{t('Категория недоступна')}</option>}
            {categories.map(category => <option key={category.id} value={category.slug}>{categoryName(category,locale)}</option>)}
          </select></Field>
          {authenticated && <CatalogModelFilter categorySlug={selectedCategory || undefined} modelId={query.get('model') ?? ''}
            withAnalogs={query.get('withAnalogs') === 'true'}
            onChange={(modelId, withAnalogs) => change({ model: modelId, withAnalogs: modelId && withAnalogs ? 'true' : '' })} />}
          {authenticated && features.feature_representation === true && <>
            <Field label={t('Представительство')}>
              <select value={query.get('representation') ?? ''} onChange={event => change({ representation: event.target.value })}>
                <option value="">{t('Любая форма')}</option><option value="DIRECT">{t('Прямая сторона')}</option>
                <option value="AGENT">{t('Агент')}</option>
              </select>
            </Field>
            <label className="admin-check">
              <input type="checkbox" checked={query.get('principalConfirmed') === 'true'}
                onChange={event => change({ principalConfirmed: event.target.checked ? 'true' : '' })} />
              {t('Подтверждённое представительство')}
            </label>
          </>}
          <Field label={t(kind === 'BUY' ? 'Тип покупателя' : 'Тип продавца')}><select value={query.get('ownerType') ?? ''} onChange={event => change({ownerType:event.target.value})}>
            <option value="">{t('Все участники')}</option>{options(['COMPANY','INDIVIDUAL'])}
          </select></Field>
          <CountrySelect
            label={t(kind === 'BUY' ? 'Страна закупки' : 'Страна отгрузки')} name="originCountry"
            value={selectedOrigin} onChange={country => change({country})}
            leading={[{ value: '', label: t('Без ограничения') }, { value: 'ANY', label: t('Указана любая страна') }]}
            hint={showFlexibleOriginHint ? t(kind === 'BUY'
              ? 'Поиск также учитывает заявки на закупку из любой страны.'
              : 'Поиск также включает предложения с отгрузкой из любой страны.') : undefined}
          />
          {kind === 'SELL' && <Field label={t('Наличие')}><select value={query.get('availability') ?? ''} onChange={event => change({availability:event.target.value})}>
            <option value="">{t('Любое')}</option>{options(['STOCK','TRANSIT','ORDER'])}
          </select></Field>}
          <details className="more-filters">
            <summary>{t('Ещё фильтры')} <Icon name="chevron-down" size={14} /></summary>
            {kind === 'BUY' && <Field label={t('География закупки')}><select value={originScope} onChange={event => change({originScope:event.target.value})}>
              <option value="">{t('Любая география')}</option>{options(['DOMESTIC','ANY','COUNTRY'])}
            </select></Field>}
            <Field label={t('Тип цены')}><select value={query.get('priceMode') ?? ''} onChange={event => change({priceMode:event.target.value})}>
              <option value="">{t('Любой')}</option><option value="FIXED">{t('Указана сумма')}</option><option value="NEGOTIABLE">{t('По договорённости')}</option>
            </select></Field>
            <CountrySelect
              label={t('Страна поставки')} name="destinationCountry"
              value={destination} onChange={destinationCountry => change({destinationCountry})}
              leading={[{ value: '', label: t('Любая страна') }]}
              hint={kind === 'SELL' && destination ? t('В результатах также будут предложения, где страну поставки можно обсудить.') : undefined}
            />
            <Field label={t('Состояние')}><select value={query.get('condition') ?? ''} onChange={event => change({condition:event.target.value})}>
              <option value="">{t('Любое')}</option>{options(['NEW','USED','REFURBISHED'])}
            </select></Field>
            <form className="filter-price" key={['priceMin','priceMax','currency'].map(key => query.get(key) ?? '').join(':')} onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const minimum = String(data.get('priceMin') ?? '');
              const maximum = String(data.get('priceMax') ?? '');
              const selectedCurrency = String(data.get('currency') ?? '');
              change({ priceMin: minimum, priceMax: maximum, currency: selectedCurrency || (minimum || maximum ? 'RUB' : '') });
            }}>
              <Field label={t('Цена от')}><input type="number" min="0" max="9999999999999.99" step="0.01" name="priceMin" defaultValue={priceMin} /></Field>
              <Field label={t('Цена до')}><input type="number" min="0" max="9999999999999.99" step="0.01" name="priceMax" defaultValue={priceMax} /></Field>
              <Field label={t('Валюта')} hint={t('Если задать диапазон и оставить валюту пустой, поиск применит RUB.')}>
                <select name="currency" defaultValue={currency}><option value="">{t('Любая')}</option>{['RUB','USD','EUR','CNY','KZT','AED'].map(value => <option key={value}>{value}</option>)}</select>
              </Field>
              <Button type="submit" variant="secondary">{t('Применить цену')}</Button>
            </form>
            <Field label={t('Контрагент')}><select value={query.get('counterparty') ?? ''} onChange={event => change({counterparty:event.target.value})}>
              <option value="">{t('Любые условия')}</option><option value="COMPANY">{t('Только компании')}</option><option value="ANY">{t('Компании и частные лица')}</option>
            </select></Field>
            <Field label={t('Оплата')}><select value={query.get('paymentMethod') ?? ''} onChange={event => change({paymentMethod:event.target.value})}>
              <option value="">{t('Любая')}</option>{options(['BANK_TRANSFER','CARD','CASH','LETTER_OF_CREDIT'])}
            </select></Field>
            <Field label={t('НДС')}><select value={query.get('vat') ?? ''} onChange={event => change({vat:event.target.value})}>
              <option value="">{t('Любые условия')}</option>{options(['INCLUDED','EXCLUDED','NA'])}
            </select></Field>
            <label className="checkbox-label"><input type="checkbox" checked={query.get('deliveryIncluded') === 'true'} onChange={event => change({deliveryIncluded:event.target.checked ? 'true' : ''})} /> {t('Доставка включена')}</label>
            <label className="checkbox-label"><input type="checkbox" checked={query.get('customsIncluded') === 'true'} onChange={event => change({customsIncluded:event.target.checked ? 'true' : ''})} /> {t('Оформление и пошлины включены')}</label>
          </details>
        </aside>
        <div className="catalog-main">
          <div className="catalog-toolbar">
            <div className="segmented" role="group" aria-label={t('Тип объявления')}>
              {oppositeKind === 'BUY' ? <Link to="/my-listings"><Icon name="tag" size={17} />{t('Мои предложения')}</Link> :
                <button type="button" aria-pressed={kind === 'SELL'} onClick={() => change({kind:'SELL',originScope:''})}><Icon name="tag" size={17} />{t('Предложения')}</button>}
              {oppositeKind === 'SELL' ? <Link to="/my-listings"><Icon name="clipboard-list" size={17} />{t('Мои заявки')}</Link> :
                <button type="button" aria-pressed={kind === 'BUY'} onClick={() => change({kind:'BUY',availability:''})}><Icon name="clipboard-list" size={17} />{t('Заявки')}</button>}
            </div>
            <label className="catalog-sort"><span className="sr-only">{t('Сортировка')}</span><select value={sort} onChange={event => change({sort:event.target.value})}>
              {(committedSearch.trim() || sort === 'relevance') && <option value="relevance">{t('По релевантности')}</option>}
              {features.feature_trust_rating === true && <option value="trust">{t('По рейтингу объявления')}</option>}
              <option value="newest">{t('Сначала новые')}</option>
              <option value="price-asc">{t('Сначала дешевле')}</option>
              <option value="price-desc">{t('Сначала дороже')}</option>
            </select></label>
          </div>
          {authenticated && features.feature_trust_rating === true && <label className="admin-check">
            <input type="checkbox" checked={query.get('showAll') === 'true'}
              onChange={event => change({ showAll: event.target.checked ? 'true' : '' })} />
            {t('Показывать объявления с низким рейтингом')}
            {Boolean(results.hiddenLowRating) && ` · ${results.hiddenLowRating}`}
          </label>}
          {error ? <Notice tone="error">{t(error)} <button className="text-link" onClick={() => setRetry(old => old + 1)}>{t('Повторить')}</button></Notice> :
          busy && authenticated ? <Spinner /> :
          locked ? <div className="locked-panel panel">
            <span className="lock-icon"><Icon name="lock-keyhole" size={25} /></span>
            <h3>{t('Войдите, чтобы увидеть объявления')}</h3>
            <p>{t('После подтверждения почты откроются цены, условия поставки и чат с участниками.')}</p>
            <div className="lock-actions"><Link className="button button-primary" to={'/register' + returnTarget}>{t('Зарегистрироваться')}</Link>
              <Link className="button button-secondary" to={'/login' + returnTarget}>{t('Войти')}</Link></div>
          </div> :
          results.items.length === 0 ? <div className="locked-panel panel"><span className="lock-icon"><Icon name="search-x" size={25} /></span>
            <h3>{t('Объявления не найдены')}</h3><p>{t('Измените запрос или уберите часть фильтров.')}</p>
            <Button variant="secondary" onClick={() => { setSearch(''); change({ ...Object.fromEntries(allFilters.map(key => [key, ''])), q: '' }); }}>{t('Очистить поиск')}</Button>
          </div> : <>
            <div className="listing-grid">{results.items.map(listing => {
              const category = listing.category ?? categories.find(category => category.id === listing.categoryId);
              return <ListingCard key={listing.id} listing={listing} category={category} returnTo={catalogReturn} />;
            })}</div>
            {resultPages > 1 && <nav className="pagination" aria-label={t('Страницы каталога')}>
              <Button variant="secondary" disabled={results.page <= 1} onClick={() => change({page:String(results.page - 1)})}><Icon name="chevron-left" size={16} /> {t('Назад')}</Button>
              <span>{t('{page} из {total}', { page: results.page, total: resultPages })}</span>
              <Button variant="secondary" disabled={results.page >= resultPages} onClick={() => change({page:String(results.page + 1)})}>{t('Дальше')} <Icon name="chevron-right" size={16} /></Button>
            </nav>}
          </>}
        </div>
      </div>
    </section>
  </div>;
}

export function ListingVisual({ listing, category }: { listing: Listing; category?: Category }) {
  const cover = listing.images?.[0];
  const imageKey = listingIllustration(listing);
  return <div className="listing-visual">
    {cover ? <ListingPhoto src={cover.url} alt="" loading="lazy" /> :
      imageKey ? <img src={`/images/${imageKey}.webp`} alt="" loading="lazy" /> :
      <Icon name={category ? categoryIcon(category) : listing.kind === 'BUY' ? 'clipboard-list' : 'server'} size={38} />}
  </div>;
}

export function listingIllustration(listing: Listing) {
  return listing.imageKey && ['h100', 'h200', 'l40s', 'server'].includes(listing.imageKey) ? listing.imageKey : null;
}

function ListingCard({ listing, category, returnTo }: { listing: Listing; category?: Category; returnTo: string }) {
  const { t, locale } = useI18n();
  const place = listing.kind === 'SELL' && listing.originScope === 'ANY' ? t('Любая страна')
    : [listing.stockCity, listing.originCountry ? countryName(listing.originCountry, locale) : listing.destinationCountry ? countryName(listing.destinationCountry, locale) : listing.owner.city].filter(Boolean).join(', ');
  const price = listing.price == null ? t('По договорённости') : (listing.kind === 'BUY' ? t('До {price}', { price: formatMoney(listing.price, listing.currency, locale) }) : formatMoney(listing.price, listing.currency, locale));
  const card = <Link className="listing-card" to={`/listings/${listing.id}`} state={{ returnTo }}>
    <ListingVisual listing={listing} category={category} />
    <div className="listing-card-body">
      <span className="listing-kicker">{listing.kind === 'BUY' ? t('Заявка на закупку') : listing.availability ? t(terms[listing.availability] ?? listing.availability) : t('Предложение')}</span>
      <h3>{listing.title}</h3>
      <strong className="listing-price">{price}</strong>
      <span className="listing-place"><Icon name="map-pin" size={15} />{place || t('Любая страна')}</span>
      <div className="listing-card-labels">
        <ListingExchangeBadges listing={listing} /><ActualityBadges listing={listing} />
      </div>
    </div>
  </Link>;
  return listing.lotGroup ? <div className="lot-catalog-card">{card}
    <LotAlternatives key={listing.lotGroup.id} listing={listing} returnTo={returnTo} />
  </div> : card;
}
