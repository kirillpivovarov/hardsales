import { useI18n } from './i18n';
import { formatMoney, type Listing } from './market';

type PriceFields = Pick<Listing, 'price' | 'currency' | 'quantity' | 'kind' | 'priceUsd' | 'totalPrice'>;

export function ListingPrice({ listing, className, usd }: {
  listing: PriceFields; className?: string; usd?: boolean;
}) {
  const { t, locale } = useI18n();
  const { price, priceUsd, currency, quantity, kind } = listing;
  const value = price === null ? t('По договорённости') : t(kind === 'BUY' ? 'До {price} за шт.' : '{price} за шт.',
    { price: formatMoney(price, currency, locale) });
  return <div className="listing-price-block">
    <strong className={className}>{value}</strong>
    {price !== null && quantity > 1 && <span className="muted listing-price-detail">
      {t(kind === 'BUY' ? 'До {price} за {quantity} шт.' : '{price} за {quantity} шт.', {
        price: formatMoney(listing.totalPrice ?? price * quantity, currency, locale), quantity,
      })}
    </span>}
    {usd && currency !== 'USD' && priceUsd != null && <span className="muted listing-price-detail">
      {t('≈ {value} USD за шт.', { value: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(priceUsd) })}
    </span>}
  </div>;
}
