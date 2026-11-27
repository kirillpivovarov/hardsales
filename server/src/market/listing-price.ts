import type { Queryable } from '../database/database.service'

/** Take before locking a listing that this transaction may reprice. */
export async function lockListingPrices(client: Queryable): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock_shared(18403, 32)')
}

export function totalPriceUsdSql(alias: 'l' | 's' | 'b'): string {
  return `round(${alias}.price * ${alias}.quantity * (
    SELECT rate.usd_per_unit FROM fx_rates rate WHERE rate.currency = ${alias}.currency
  ), 2)`
}
