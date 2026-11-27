import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from './api'
import { useI18n } from './i18n'
import { Button, Field, Notice } from './ui'

type Requirement = { kind: 'COMPANY_CARD' | 'SIGNATORY'; label: string; status: 'MISSING' | 'PENDING' | 'REJECTED' | 'APPROVED' }
type Verification = {
  requirements: Requirement[]
  principalEmail: { required: boolean; status: 'MISSING' | 'PENDING' | 'APPROVED'; principalId: string | null }
}

function RequirementUpload({ requirement, refresh }: { requirement: Requirement; refresh: () => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { kind, label, status } = requirement
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const body = new FormData(event.currentTarget)
    body.set('data', JSON.stringify({ kind }))
    setError(''); setBusy(true)
    try {
      await api('/documents', { method: 'POST', body })
      refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось загрузить документ.')
    } finally { setBusy(false) }
  }
  if (status === 'PENDING' || status === 'APPROVED') {
    return <p><strong>{t(label)}</strong> · {t(status === 'PENDING' ? 'На проверке' : 'Подтверждён')}</p>
  }
  return <form className="workflow-stack" onSubmit={upload} aria-busy={busy}>
    <Field label={t(label)} hint={t(kind === 'SIGNATORY' ? 'Приказ о назначении или доверенность. PDF или фото.' : 'PDF или фото.')}>
      <input name="file" type="file" accept="image/*,.pdf,application/pdf" required />
    </Field>
    {status === 'REJECTED' && <p>{t('Документ отклонён. Загрузите исправленный.')}</p>}
    {error && <Notice tone="error">{t(error)}</Notice>}
    <div><Button type="submit" variant="secondary" disabled={busy}>{t('Загрузить')}</Button></div>
  </form>
}

function PrincipalEmail({ principal, refresh }: { principal: Verification['principalEmail']; refresh: () => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError(''); setBusy(true)
    const email = new FormData(event.currentTarget).get('email')
    try {
      await api('/me/principals/' + principal.principalId + '/email', { method: 'POST', body: { email } })
      refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Не удалось отправить письмо.')
    } finally { setBusy(false) }
  }
  if (!principal.required) return null
  const title = 'Подтверждение компании-принципала по почте'
  if (principal.status !== 'MISSING') return <p><strong>{t(title)}</strong> · {t(principal.status === 'APPROVED' ? 'Получено' : 'Ожидается ответ')}</p>
  if (!principal.principalId) return <p><strong>{t(title)}</strong> · <Link to="/account">{t('Добавьте принципала в профиле')}</Link></p>
  return <form className="workflow-stack" onSubmit={send} aria-busy={busy}>
    <Field label={t(title)}><input name="email" type="email" maxLength={254} placeholder={t('Рабочая почта компании')} required /></Field>
    {error && <Notice tone="error">{t(error)}</Notice>}
    <div><Button type="submit" variant="secondary" disabled={busy}>{t('Отправить письмо компании')}</Button></div>
  </form>
}

export function RevealVerification() {
  const { t } = useI18n()
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<Verification>()
  const [error, setError] = useState('')
  function refresh() { setRevision(value => value + 1) }
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void api<Verification>('/me/verification', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState(data)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить список документов.')
    })
    return () => controller.abort()
  }, [revision])
  const awaiting = state?.requirements.every(item => item.status === 'PENDING' || item.status === 'APPROVED')
  return <div className="workflow-stack chat-verification">
    <details className="chat-verification-details">
      <summary>{t('Чтобы открыть контакты, загрузите 2 документа (около 5 минут)')}</summary>
      <div className="workflow-stack">
        {error && <><Notice tone="error">{t(error)}</Notice><Button variant="secondary" onClick={refresh}>{t('Повторить')}</Button></>}
        {!state && !error && <p role="status">{t('Загружаем список документов…')}</p>}
        {state?.requirements.map(requirement => <RequirementUpload key={requirement.kind} requirement={requirement} refresh={refresh} />)}
        {state && <PrincipalEmail principal={state.principalEmail} refresh={refresh} />}
        <p>{t('После проверки модератором вы сможете открыть контакты. Мы сообщим по почте.')}</p>
      </div>
    </details>
    {awaiting && <Button type="button" variant="secondary" disabled>{t('Документы на проверке')}</Button>}
  </div>
}
