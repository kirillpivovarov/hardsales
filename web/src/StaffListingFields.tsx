import { useState } from 'react'
import { useExchange } from './Exchange'
import { useI18n } from './i18n'
import { Field } from './ui'

export type StaffListingOwner = {
  id: string; role: 'BUYER' | 'SELLER'; tradeSides: ('SELL' | 'BUY')[]; country: string; nickname: string
  representationMode: 'DIRECT' | 'AGENT' | 'BOTH'
  principals: { id: string; name: string; company: string; confirmed: boolean }[]
}

export function StaffRepresentationFields({ owner }: { owner: StaffListingOwner }) {
  const { t } = useI18n()
  const { features } = useExchange()
  const [choice, setChoice] = useState('DIRECT')
  if (features.feature_representation !== true || owner.representationMode === 'DIRECT') return null
  const both = owner.representationMode === 'BOTH'
  const selected = both ? choice : 'AGENT'
  return <section className="panel workflow-section workflow-stack">
    {both ? <Field label={t('Как работает владелец')}>
      <select name="representation" value={choice} onChange={event => setChoice(event.target.value)}>
        <option value="DIRECT">{t('Прямая сторона')}</option><option value="AGENT">{t('Агент')}</option>
      </select>
    </Field> : <input type="hidden" name="representation" value={selected} />}
    {selected === 'AGENT' && <Field label={t('Принципал владельца')}>
      <select name="principalId" required defaultValue={owner.principals.length === 1 ? owner.principals[0].id : ''}>
        <option value="">{t('Выберите принципала')}</option>
        {owner.principals.map(item => <option key={item.id} value={item.id}>
          {[item.name, item.company].filter(Boolean).join(' · ')}
        </option>)}
      </select>
    </Field>}
  </section>
}
