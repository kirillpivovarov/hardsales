import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from './api';
import type { User } from './api';
import { useI18n } from './i18n';
import { ListingPhoto } from './ListingImages';
import { categoryIcon, categoryName, countries, countryName, formatMoney, terms } from './market';
import type { Category, Listing } from './market';
import { Button, Field, Icon, Notice, Spinner } from './ui';

interface Results {
  items: Listing[];
  total: number;
  page: number;
  limit: number;
  locked: boolean;
}

const emptyResults: Results = { items: [], total: 0, page: 1, limit: 12, locked: false };

export function CatalogPage({ user, home = false }: { user: User | null; home?: boolean }) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useSearchParams();
  const committedSearch = query.get('q') ?? '';
  const [search, setSearch] = useState(committedSearch);
  const [categories, setCategories] = useState<Category[]>([]);
  const [results, setResults] = useState<Results>(emptyResults);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const oppositeKind = user?.role === 'SELLER' ? 'BUY' : user?.role === 'BUYER' ? 'SELL' : null;
  const kind = oppositeKind ?? (query.get('kind') === 'BUY' ? 'BUY' : 'SELL');
  const selectedCategory = query.get('category') ?? '';
  const selectedOrigin = query.get('country') ?? '';
  const showFlexibleOriginHint = kind === 'SELL' && /^[A-Z]{2}$/.test(selectedOrigin);
  const authenticated = Boolean(user?.emailVerified);
  const locked = !authenticated || results.locked;
  const requestedQuery = query.toString();
  const sortedCountries = useMemo(() => countries.map(code => ({code, name: countryName(code,locale)}))
    .sort((a,b) => a.name.localeCompare(b.name, locale)), [locale]);

  useEffect(() => { setSearch(committedSearch); }, [committedSearch]);
  useEffect(() => {
    const controller = new AbortController();
    void api<Category[]>('/categories', { signal: controller.signal }).then(setCategories).catch(() => {});
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    const params = new URLSearchParams(requestedQuery);
    params.set('kind', kind);
    if (kind === 'BUY') params.delete('availability');
    else params.delete('originScope');
    api<Results>('/listings?' + params.toString(), { signal: controller.signal }).then(data => {
      setResults(data);
      setBusy(false);
    }).catch((caught: Error) => {
      if (controller.signal.aborted) return;
      setError(caught.message);
      setBusy(false);
    });
    return () => controller.abort();
  }, [requestedQuery, kind, user?.id, authenticated, retry]);

  function change(values: Record<string,string>) {
    const next = new URLSearchParams(query);
    if (!('page' in values)) next.delete('page');
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
  const countryOptions = sortedCountries.map(({code,name}) => <option key={code} value={code}>{name}</option>);
  const allFilters = ['category','country','destinationCountry','ownerType','availability','condition','originScope','priceMode','counterparty','paymentMethod','priceMin','priceMax','currency','vat','deliveryIncluded','customsIncluded'];
  const filterCount = allFilters.filter(key => query.has(key)).length;
  const resultPages = Math.ceil(results.total / results.limit);
  const returnTarget = `?next=${encodeURIComponent('/catalog' + (requestedQuery ? '?' + requestedQuery : ''))}`;
  const catalogReturn = `${home ? '/' : '/catalog'}${requestedQuery ? '?' + requestedQuery : ''}#catalog`;

  return <div className="container market-page">
    {home && <section className="market-hero" aria-labelledby="hero-title">
      <div className="hero-art" aria-hidden="true"><img src="/images/rack.webp" alt="" fetchPriority="high" /></div>
      <div className="hero-copy">
        <p className="eyebrow"><span className="signal" /> {t('ПЛОЩАДКА ДЛЯ AI-ИНФРАСТРУКТУРЫ')}</p>
        <h1 id="hero-title">{t('Серверное железо')}<br /><em>{t('для ИИ')}</em></h1>
        <p className="hero-description">{t('Покупайте и продавайте GPU, серверы и комплектующие для обучения и запуска моделей.')}</p>
        <form className="hero-search" onSubmit={submitSearch} role="search">
          <Icon name="search" size={20} />
          <input aria-label={t('Поиск оборудования')} placeholder={t('Например, NVIDIA H100 или Dell R760')} value={search} onChange={event => setSearch(event.target.value)} name="q" maxLength={150} />
          <Button type="submit">{t('Найти')}</Button>
        </form>
      </div>
    </section>}
    {categoryTiles.length > 0 && <section className="categories-section" aria-labelledby="category-title">
      <div className="section-heading"><h2 id="category-title">{t('Категории')}</h2><a className="text-link" href="#catalog" onClick={() => change({category:''})}>{t('Все категории')} <Icon name="chevron-down" size={16} /></a></div>
      <div className="category-grid">
        {categoryTiles.map(category => <button key={category.id} className={'category-tile' + (category.slug === selectedCategory ? ' selected' : '')} aria-pressed={category.slug === selectedCategory}
          onClick={() => { change({ category: category.slug === selectedCategory ? '' : category.slug }); document.getElementById('catalog')?.scrollIntoView(); }}>
          <span className="category-icon"><Icon name={categoryIcon(category)} size={24} /></span>
          <span>{categoryName(category, locale, true)}</span>
        </button>)}
      </div>
    </section>}
    <section className="catalog" id="catalog" aria-labelledby="catalog-title">
      <div className="section-heading catalog-heading">
        {home ? <h2 id="catalog-title">{t('Каталог оборудования')}</h2> : <h1 id="catalog-title">{t('Каталог оборудования')}</h1>}
        {!locked && !busy && !error && <span className="count-meta">{t('Найдено · {count}', { count: results.total })}</span>}
      </div>
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
            {categories.map(category => <option key={category.id} value={category.slug}>{categoryName(category,locale)}</option>)}
          </select></Field>
          <Field label={t(kind === 'BUY' ? 'Тип покупателя' : 'Тип продавца')}><select value={query.get('ownerType') ?? ''} onChange={event => change({ownerType:event.target.value})}>
            <option value="">{t('Все участники')}</option>{options(['COMPANY','INDIVIDUAL'])}
          </select></Field>
          <div className="field">
            <Field label={t(kind === 'BUY' ? 'Страна закупки' : 'Страна отгрузки')}>
              <select value={selectedOrigin} aria-describedby={showFlexibleOriginHint ? 'origin-filter-hint' : undefined}
                onChange={event => change({country:event.target.value})}>
                <option value="">{t('Без ограничения')}</option>
                <option value="ANY">{t('Указана любая страна')}</option>{countryOptions}
              </select>
            </Field>
            {showFlexibleOriginHint && <small id="origin-filter-hint">{t('Поиск также включает предложения с отгрузкой из любой страны.')}</small>}
          </div>
          {kind === 'SELL' && <Field label={t('Наличие')}><select value={query.get('availability') ?? ''} onChange={event => change({availability:event.target.value})}>
            <option value="">{t('Любое')}</option>{options(['STOCK','TRANSIT','ORDER'])}
          </select></Field>}
          <details className="more-filters">
            <summary>{t('Ещё фильтры')} <Icon name="chevron-down" size={14} /></summary>
            {kind === 'BUY' && <Field label={t('География закупки')}><select value={query.get('originScope') ?? ''} onChange={event => change({originScope:event.target.value})}>
              <option value="">{t('Любая география')}</option>{options(['DOMESTIC','ANY','COUNTRY'])}
            </select></Field>}
            <Field label={t('Тип цены')}><select value={query.get('priceMode') ?? ''} onChange={event => change({priceMode:event.target.value})}>
              <option value="">{t('Любой')}</option><option value="FIXED">{t('Указана сумма')}</option><option value="NEGOTIABLE">{t('По договорённости')}</option>
            </select></Field>
            <Field label={t('Страна поставки')}><select value={query.get('destinationCountry') ?? ''} onChange={event => change({destinationCountry:event.target.value})}>
              <option value="">{t('Любая страна')}</option>{countryOptions}
            </select></Field>
            <Field label={t('Состояние')}><select value={query.get('condition') ?? ''} onChange={event => change({condition:event.target.value})}>
              <option value="">{t('Любое')}</option>{options(['NEW','USED','REFURBISHED'])}
            </select></Field>
            <form className="filter-price" key={['priceMin','priceMax','currency'].map(key => query.get(key) ?? '').join(':')} onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              change({ priceMin: String(data.get('priceMin') ?? ''), priceMax: String(data.get('priceMax') ?? ''), currency: String(data.get('currency') ?? '') });
            }}>
              <Field label={t('Цена от')}><input type="number" min="0" max="999999999999" step="any" name="priceMin" defaultValue={query.get('priceMin') ?? ''} /></Field>
              <Field label={t('Цена до')}><input type="number" min="0" max="999999999999" step="any" name="priceMax" defaultValue={query.get('priceMax') ?? ''} /></Field>
              <Field label={t('Валюта')}><select name="currency" defaultValue={query.get('currency') ?? ''}><option value="">{t('Любая')}</option>{['RUB','USD','EUR','CNY','KZT','AED'].map(value => <option key={value}>{value}</option>)}</select></Field>
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
            <label className="catalog-sort"><span className="sr-only">{t('Сортировка')}</span><select value={query.get('sort') ?? 'newest'} onChange={event => change({sort:event.target.value})}>
              <option value="newest">{t('Сначала новые')}</option>
              <option value="price-asc">{t('Сначала дешевле')}</option>
              <option value="price-desc">{t('Сначала дороже')}</option>
            </select></label>
          </div>
          {!home && <form className="catalog-search" onSubmit={submitSearch} role="search">
            <Icon name="search" size={19} /><input aria-label={t('Поиск оборудования')} placeholder={t('Название, модель или спецификация')} value={search} maxLength={150} onChange={event => setSearch(event.target.value)} /><Button type="submit">{t('Найти')}</Button>
          </form>}
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
            <div className="listing-grid">{results.items.map(listing => <ListingCard key={listing.id} listing={listing} category={listing.category ?? categories.find(category => category.id === listing.categoryId)} returnTo={catalogReturn} />)}</div>
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
  const imageKey = listing.imageKey && ['h100','h200','l40s','server'].includes(listing.imageKey) ? listing.imageKey : null;
  return <div className="listing-visual">
    {cover ? <ListingPhoto src={cover.url} alt="" loading="lazy" /> :
      imageKey ? <img src={`/images/${imageKey}.webp`} alt="" loading="lazy" /> :
      <Icon name={category ? categoryIcon(category) : listing.kind === 'BUY' ? 'clipboard-list' : 'server'} size={55} />}
  </div>;
}

function ListingCard({ listing, category, returnTo }: { listing: Listing; category?: Category; returnTo: string }) {
  const { t, locale } = useI18n();
  const place = listing.kind === 'SELL' && listing.originScope === 'ANY' ? t('Любая страна')
    : [listing.stockCity, listing.originCountry ? countryName(listing.originCountry, locale) : listing.destinationCountry ? countryName(listing.destinationCountry, locale) : listing.owner.city].filter(Boolean).join(', ');
  const price = listing.price == null ? t('По договорённости') : (listing.kind === 'BUY' ? t('До {price}', { price: formatMoney(listing.price, listing.currency, locale) }) : formatMoney(listing.price, listing.currency, locale));
  return <Link className="listing-card" to={`/listings/${listing.id}`} state={{ returnTo }}>
    <ListingVisual listing={listing} category={category} />
    <div className="listing-card-body">
      <span className="listing-kicker">{listing.kind === 'BUY' ? t('Заявка на закупку') : listing.availability ? t(terms[listing.availability] ?? listing.availability) : t('Предложение')}</span>
      <h3>{listing.title}</h3>
      <strong className="listing-price">{price}</strong>
      <span className="listing-place"><Icon name="map-pin" size={15} />{place || t('Любая страна')}</span>
    </div>
  </Link>;
}
