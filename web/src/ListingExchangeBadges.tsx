import { useI18n } from './i18n';
import type { Listing } from './market';
import { TrustBadges } from './Trust';

export function ListingExchangeBadges({ listing }: { listing: Listing }) {
  const { t } = useI18n();
  if (!listing.model && !listing.trust && !listing.labels?.length) return null;
  return <div className="exchange-listing-labels">
    {listing.model && <span className="contextual-status">{listing.model.nameRu}</span>}
    {listing.labels?.map(label => <span className="contextual-status" key={label.id}>{t(label.text)}</span>)}
    <TrustBadges listing={listing} />
  </div>;
}
