import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, type User } from './api';
import { useI18n } from './i18n';
import { Button, Field, Notice, Spinner } from './ui';
import './models.css';

export interface HardwareModel {
  id: string;
  nameRu: string;
  nameEn: string;
  categorySlug: string;
  family?: string | null;
  gpuCount: number | null;
  gpuModel?: string | null;
  memoryGb: number | null;
  formFactor: string | null;
  status: 'ACTIVE' | 'PENDING' | 'DISABLED';
}
interface ModelFamily { key: string; label: string; models: HardwareModel[] }
interface ModelPage<T> { items: T[]; total: number; page: number; limit: number }
interface AdminModel extends HardwareModel {
  aliases: string[]; pciIds: string[]; source: string[]; sortOrder: number; analogGroupId: string | null;
  listingCount: number; proposedBy: string | null; familyLabel: string | null;
}
interface ModelOptions {
  families: { key: string; code: string; label: string }[];
  groups: { id: string; familyCode: string; categorySlug: string; rack: boolean }[];
  categories: { slug: string; name: string }[];
}
interface ModelSuggestion { id: string; nameRu: string; matchedAlias: string }

function useModelData<T>(path: string | null, revision = 0) {
  const key = path === null ? null : `${path}:${revision}`;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>();
  useEffect(() => {
    if (!path || !key) return;
    const abort = new AbortController();
    void api<T>(path, { signal: abort.signal }).then(data => {
      if (!abort.signal.aborted) setResult({ key, data });
    }).catch((error: Error) => {
      if (!abort.signal.aborted) setResult({ key, error: error.message });
    });
    return () => abort.abort();
  }, [path, key]);
  const current = key && result?.key === key ? result : undefined;
  return { data: current?.data, error: current?.error, loading: Boolean(key && !current) };
}

function useDebounce(value: string, delay: number) {
  const [latest, setLatest] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setLatest(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return latest;
}

function modelName(model: HardwareModel, locale: string) {
  return locale.startsWith('ru') ? model.nameRu : model.nameEn;
}

function modelPath(category: string, q = '') {
  const query = new URLSearchParams();
  if (category) query.set('category', category);
  if (q) query.set('q', q);
  return `/models?${query}`;
}

function ModelPicker({ families, value, id, emptyLabel = 'Без модели', onChange }: {
  families: ModelFamily[]; value: string; id?: string; emptyLabel?: string; onChange: (value: string, model?: HardwareModel) => void;
}) {
  const { t, locale } = useI18n();
  const find = (id: string) => families.flatMap(group => group.models).find(model => model.id === id);
  return <select id={id} value={value} onChange={event => onChange(event.target.value, find(event.target.value))}>
    <option value="">{t(emptyLabel)}</option>
    {value && !find(value) && <option value={value}>{value}</option>}
    {families.map(family => <optgroup key={family.key} label={t(family.label)}>
      {family.models.map(model => <option key={model.id} value={model.id}>
        {modelName(model, locale)}{model.status === 'PENDING' ? ` · ${t('ждёт проверки')}` : ''}
      </option>)}
    </optgroup>)}
  </select>;
}

type ListingModelValue = { modelId: string | null; analogModelIds: string[] };
export function ListingModelFields({ categorySlug, title, modelId, analogModelIds, buyer, canPropose = true, onChange, onSelectModel }: {
  categorySlug: string; title: string; modelId: string | null; analogModelIds: string[]; buyer: boolean; canPropose?: boolean;
  onChange: (value: ListingModelValue) => void; onSelectModel?: (model: HardwareModel) => void;
}) {
  const { t, locale } = useI18n();
  const [filter, setFilter] = useState('');
  const [proposal, setProposal] = useState(false);
  const [proposalName, setProposalName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const proposalRequest = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => proposalRequest.current?.abort(), [categorySlug]);
  const search = useDebounce(filter.trim(), 250);
  const searchTitle = useDebounce(title.trim(), 400);
  const all = useModelData<{ families: ModelFamily[] }>(categorySlug ? modelPath(categorySlug) : null, revision);
  const filtered = useModelData<{ families: ModelFamily[] }>(categorySlug && search ? modelPath(categorySlug, search) : null, revision);
  const suggest = useModelData<{ items: ModelSuggestion[] }>(categorySlug && searchTitle.length >= 2 && !modelId && all.data?.families.length
    ? `/models/suggest?${new URLSearchParams({ category: categorySlug, q: searchTitle.slice(0, 200) })}` : null);
  const analogs = useModelData<{ group: HardwareModel[]; others: ModelFamily[] }>(buyer && modelId && categorySlug
    ? `/models/${encodeURIComponent(modelId)}/analogs` : null, revision);
  const families = all.data?.families ?? [];
  if (!categorySlug || (families.length === 0 && !modelId && !all.error)) return null;

  function select(id: string, model?: HardwareModel) {
    onChange({ modelId: id || null, analogModelIds: id === modelId ? analogModelIds : [] });
    if (model) onSelectModel?.(model);
    setError('');
  }

  async function propose() {
    if (busy || proposalName.trim().length < 3) return;
    const controller = new AbortController();
    proposalRequest.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ model: HardwareModel; existing: boolean }>('/models/proposals', {
        method: 'POST', signal: controller.signal, body: { name: proposalName.trim(), category: categorySlug },
      });
      if (controller.signal.aborted) return;
      if (!families.flatMap(group => group.models).some(model => model.categorySlug === result.model.categorySlug)) {
        setError('Модель относится к другой категории. Выберите подходящую категорию.');
        return;
      }
      select(result.model.id, result.model);
      setFilter('');
      setProposalName('');
      setProposal(false);
      setRevision(current => current + 1);
      setMessage(result.existing ? 'Модель уже есть в справочнике.' : 'Модель предложена и ждёт проверки.');
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось предложить модель.');
    } finally {
      if (proposalRequest.current === controller) {
        proposalRequest.current = undefined;
        setBusy(false);
      }
    }
  }

  function analogList(models: HardwareModel[]) {
    return <div className="model-checkboxes">{models.map(model => <label key={model.id} className="checkbox-label">
      <input type="checkbox" checked={analogModelIds.includes(model.id)} disabled={!analogModelIds.includes(model.id) && analogModelIds.length >= 10}
        onChange={event => onChange({ modelId, analogModelIds: event.target.checked ? [...analogModelIds, model.id] : analogModelIds.filter(id => id !== model.id) })} />
      {modelName(model, locale)}
    </label>)}</div>;
  }

  const first = suggest.data?.items[0];
  return <div className="model-fields workflow-span">
    {first && <div className="model-inline"><span>{t('Похоже на {name}', { name: first.nameRu })}</span>
      <Button variant="secondary" onClick={() => select(first.id, families.flatMap(group => group.models).find(model => model.id === first.id))}>{t('Выбрать')}</Button>
    </div>}
    <Field label={t('Поиск модели по справочнику')}><input type="search" value={filter} maxLength={200} onChange={event => setFilter(event.target.value)} /></Field>
    <Field label={t('Модель по справочнику')} hint={t('Необязательно. С моделью из справочника площадка может найти встречные объявления.') }>
      <ModelPicker families={search ? filtered.data?.families ?? [] : families} value={modelId ?? ''} onChange={select} />
    </Field>
    {canPropose && <Button variant="ghost" aria-expanded={proposal} onClick={() => { setProposal(current => !current); setMessage(''); }}>{t('Нет в списке: предложить модель')}</Button>}
    {canPropose && proposal && <div className="model-form">
      <Field label={t('Название новой модели')} hint={t('Объявление с предложенной моделью публикуется сразу. Поиск совпадений начнётся после проверки модели.') }>
        <input value={proposalName} maxLength={80} onChange={event => setProposalName(event.target.value)} onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); void propose(); }
        }} />
      </Field>
      <Button variant="secondary" disabled={busy || proposalName.trim().length < 3} onClick={() => void propose()}>{t('Предложить модель')}</Button>
    </div>}
    {(error || all.error || filtered.error) && <Notice tone="error">{t(error || all.error || filtered.error || '')}</Notice>}
    {message && <Notice tone="success">{t(message)}</Notice>}
    {buyer && modelId && analogs.data && <details className="model-analogs">
      <summary>{t('Допустимые аналоги')} · {analogModelIds.length}/10</summary>
      <p className="muted">{t('Совпадения по аналогам ищутся только для моделей, которые вы отметите.')}</p>
      {analogs.data.group.length > 0 && <details open><summary>{t('Похожие')}</summary>{analogList(analogs.data.group)}</details>}
      {analogs.data.others.map(family => <details key={family.key}><summary>{t(family.label)}</summary>{analogList(family.models)}</details>)}
    </details>}
  </div>;
}

export function CatalogModelFilter({ categorySlug, modelId, withAnalogs, onChange }: {
  categorySlug?: string; modelId: string; withAnalogs: boolean; onChange: (modelId: string, withAnalogs: boolean) => void;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const term = useDebounce(filter.trim(), 250);
  const models = useModelData<{ families: ModelFamily[] }>(modelPath(categorySlug ?? '', term));
  const families = (models.data?.families ?? []).map(group => ({ ...group, models: group.models.filter(model => model.status === 'ACTIVE') })).filter(group => group.models.length);
  return <div className="model-fields">
    <Field label={t('Поиск модели')}><input type="search" maxLength={200} value={filter} onChange={event => setFilter(event.target.value)} /></Field>
    <Field label={t('Модель')}><ModelPicker value={modelId} families={families} emptyLabel="Все модели" onChange={id => onChange(id, Boolean(id) && withAnalogs)} /></Field>
    <label className="checkbox-label"><input type="checkbox" checked={withAnalogs} disabled={!modelId}
      onChange={event => onChange(modelId, event.target.checked)} />{t('С аналогами')}</label>
  </div>;
}

const modelStatus: Record<string, string> = { ACTIVE: 'Действует', PENDING: 'Ждёт проверки', DISABLED: 'Выключена' };
const modelKinds: Record<string, string> = { NEW_MODEL: 'Новая модель', LINK_PCI: 'Привязка PCI', RENAMED: 'Новое название', GONE: 'Код не найден', SIGNAL: 'Сигнал по серверам' };
const queueStatuses: Record<string, string> = { PENDING: 'Ждёт проверки', ACCEPTED: 'Рассмотрено', REJECTED: 'Отклонено' };
const checkStatuses: Record<string, string> = { OK: 'Обновлён', NOT_MODIFIED: 'Без изменений', FAILED: 'Недоступен', REJECTED: 'Данные отклонены' };
const decisions: Record<string, string> = { ACCEPT: 'Принять', MERGE: 'Объединить', LINK: 'Привязать', REJECT: 'Отклонить', ACK: 'Принять к сведению' };
const codes: Record<string, string> = { PCI_IDS: 'База PCI ID', NVIDIA_PAGES: 'Страницы NVIDIA', WIKIPEDIA_DGX: 'Википедия DGX' };
const lines = (value: FormDataEntryValue | null) => String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);

function AdminModelEditor({ model, options, done, cancel }: { model?: AdminModel; options: ModelOptions; done: (message?: string) => void; cancel: () => void }) {
  const { t } = useI18n();
  const [category, setCategory] = useState(model?.categorySlug ?? options.categories[0]?.slug ?? '');
  const [family, setFamily] = useState(model?.family ?? '');
  const [formFactor, setFormFactor] = useState(model?.formFactor ?? '');
  const [group, setGroup] = useState(model?.analogGroupId ?? '');
  const familyCode = options.families.find(item => item.key === family)?.code;
  const groups = options.groups.filter(item => item.categorySlug === category && item.familyCode === familyCode && item.rack === (formFactor === 'rack'));
  return <StaffForm title={t(model ? 'Редактирование модели' : 'Новая модель')} cancel={cancel} done={done} save={async fields => {
    const body = Object.fromEntries(fields);
    const result = await api<{ aliasConflicts?: { alias: string; modelId: string }[] }>(`/admin/models${model ? `/${model.id}` : ''}`, {
      method: model ? 'PATCH' : 'POST', body: { ...body, aliases: lines(fields.get('aliases')), pciIds: lines(fields.get('pciIds')), source: lines(fields.get('source')) },
    });
    return result.aliasConflicts?.length ? t('Сохранено. Совпадающие псевдонимы: {aliases}', { aliases: result.aliasConflicts.map(item => `${item.alias} (${item.modelId})`).slice(0, 5).join(', ') }) : undefined;
  }}>
    <div className="form-grid model-form">
      <Field label={t('Код модели')} hint={t('Можно оставить пустым, чтобы сформировать код из названия.') }>
        <input name="id" defaultValue={model?.id} pattern={String.raw`[a-z0-9][a-z0-9\-]{1,47}`} maxLength={48} disabled={Boolean(model)} />
      </Field>
      <Field label={t('Название на русском')}><input name="nameRu" defaultValue={model?.nameRu} minLength={2} maxLength={120} required /></Field>
      <Field label={t('Название на английском')}><input name="nameEn" defaultValue={model?.nameEn} minLength={2} maxLength={120} required /></Field>
      <Field label={t('Категория')}><select name="categorySlug" value={category} onChange={event => { setCategory(event.target.value); setGroup(''); }} required>
        {options.categories.map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}
      </select></Field>
      <Field label={t('Семейство')}><select name="family" value={family} onChange={event => { setFamily(event.target.value); setGroup(''); }}>
        <option value="">{t('Без семейства')}</option>{options.families.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select></Field>
      <Field label={t('Форм-фактор')}><select name="formFactor" value={formFactor} onChange={event => { setFormFactor(event.target.value); setGroup(''); }}>
        <option value="">{t('Не указан')}</option>{['SXM', 'PCIe', 'NVL', 'OAM', 'rack'].map(value => <option key={value}>{value}</option>)}
      </select></Field>
      <Field label={t('Группа аналогов')}><select name="analogGroupId" value={group} onChange={event => setGroup(event.target.value)}>
        <option value="">{t('Без группы')}</option>{groups.map(item => <option key={item.id}>{item.id}</option>)}
      </select></Field>
      <Field label={t('Модель GPU')}><input name="gpuModel" defaultValue={model?.gpuModel ?? ''} maxLength={60} /></Field>
      <Field label={t('Количество GPU')}><input type="number" name="gpuCount" min={1} max={1000} defaultValue={model?.gpuCount ?? ''} /></Field>
      <Field label={t('Видеопамять одного GPU, ГБ')}><input type="number" name="memoryGb" min={1} max={100000} defaultValue={model?.memoryGb ?? ''} /></Field>
      <Field label={t('Порядок')}><input type="number" name="sortOrder" min={0} max={100000} defaultValue={model?.sortOrder ?? 1000} /></Field>
      <Field label={t('Псевдонимы, по одному в строке')}><textarea name="aliases" rows={5} defaultValue={model?.aliases.join('\n')} /></Field>
      <Field label={t('Коды PCI, по одному в строке')}><textarea name="pciIds" rows={5} defaultValue={model?.pciIds.join('\n')} /></Field>
      <Field label={t('Источники, по одному в строке')}><textarea name="source" rows={5} defaultValue={model?.source.join('\n')} /></Field>
    </div>
  </StaffForm>;
}

function StaffForm({ title, children, save, done, cancel, submit }: {
  title: string; children?: ReactNode; save: (form: FormData) => Promise<string | void>;
  done: (message?: string) => void; cancel: () => void; submit?: string;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function handle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try { done((await save(data)) || undefined); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить изменения.'); }
    finally { setBusy(false); }
  }
  return <form className="model-editor" onSubmit={handle} aria-busy={busy}>
    <h3>{title}</h3>{children}{error && <Notice tone="error">{t(error)}</Notice>}
    <div className="admin-actions"><Button variant="ghost" onClick={cancel} disabled={busy}>{t('Отмена')}</Button>
      <Button type="submit" disabled={busy}>{t(submit ?? 'Сохранить')}</Button></div>
  </form>;
}

function Pager({ page, limit, total, change }: { page: number; limit: number; total: number; change: (page: number) => void }) {
  const { t } = useI18n();
  if (total <= limit && page <= 1) return null;
  return <div className="admin-actions">
    <Button variant="secondary" disabled={page <= 1} onClick={() => change(page - 1)}>{t('Назад')}</Button>
    <span>{t('Страница {page}', { page })}</span>
    <Button variant="secondary" disabled={page * limit >= total} onClick={() => change(page + 1)}>{t('Далее')}</Button>
  </div>;
}

export function CatalogModelsPage({ user }: { user?: User | null } = {}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'models' | 'sync' | 'sources' | 'legacy'>('models');
  return <div className="models-page">
    <h2>{t('Модели оборудования')}</h2>
    <div className="admin-actions" aria-label={t('Разделы справочника')}>
      {([['models', 'Справочник'], ['sync', 'Обновления каталога'], ['sources', 'Источники'], ['legacy', 'Прежние объявления']] as const)
        .map(([key, label]) => <Button key={key} variant={tab === key ? 'secondary' : 'ghost'} aria-pressed={tab === key} onClick={() => setTab(key)}>{t(label)}</Button>)}
    </div>
    {tab === 'models' && <StaffModels />}
    {tab === 'sync' && <SyncQueue />}
    {tab === 'sources' && <SyncSources canEdit={user?.role === 'ADMIN'} />}
    {tab === 'legacy' && <BackfillModels />}
  </div>;
}

function StaffModels() {
  const { t, locale } = useI18n();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<{ mode: 'edit' | 'merge' | 'status' | 'approve'; model?: AdminModel }>();
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const query = new URLSearchParams({ q: useDebounce(search.trim(), 250), status, page: String(page), limit: '20' });
  const models = useModelData<ModelPage<AdminModel>>(`/admin/models?${query}`, revision);
  const options = useModelData<ModelOptions>('/admin/models/options', revision);
  const selected = editing?.model;
  const active = useModelData<{ families: ModelFamily[] }>(editing?.mode === 'merge' && selected ? modelPath(selected.categorySlug) : null);
  function done(msg?: string) {
    setMessage(msg ?? 'Изменения сохранены.'); setEditing(undefined); setRevision(current => current + 1);
  }
  return <div className="model-panel">
    <div className="form-grid model-form">
      <Field label={t('Поиск моделей')}><input type="search" maxLength={200} value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></Field>
      <Field label={t('Статус')}><select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
        <option value="">{t('Все статусы')}</option>{Object.entries(modelStatus).map(([key, label]) => <option value={key} key={key}>{t(label)}</option>)}
      </select></Field>
    </div>
    <div><Button onClick={() => setEditing({ mode: 'edit' })}>{t('Добавить модель')}</Button></div>
    {message && <Notice tone="success">{t(message)}</Notice>}
    {(models.error || options.error) && <Notice tone="error">{t(models.error ?? options.error ?? '')}</Notice>}
    {editing?.mode === 'edit' && options.data && <AdminModelEditor key={selected?.id ?? 'new'} model={selected} options={options.data} done={done} cancel={() => setEditing(undefined)} />}
    {editing && selected && editing.mode !== 'edit' && <StaffForm key={editing.mode + selected.id} title={modelName(selected, locale)} done={done} cancel={() => setEditing(undefined)} save={async fields => {
      const mode = editing.mode;
      const body = mode === 'status' ? { status: selected.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED', reason: fields.get('reason') }
        : mode === 'merge' ? { intoModelId: fields.get('intoModelId'), reason: fields.get('reason') } : { reason: fields.get('reason') };
      await api(`/admin/models/${selected.id}/${mode}`, { method: mode === 'status' ? 'PATCH' : 'POST', body });
    }}>
      {editing.mode === 'merge' && <MergeTarget families={active.data?.families ?? []} />}
      <Field label={t('Причина')}><textarea name="reason" minLength={3} maxLength={500} required={editing.mode !== 'approve'} /></Field>
    </StaffForm>}
    {models.loading && <Spinner />}
    <ul className="model-records">
      {models.data?.items.map(model => <li key={model.id}>
        <div><strong>{modelName(model, locale)}</strong><div className="muted">{model.id} · {model.categorySlug} · {model.familyLabel ?? '—'} · {t(modelStatus[model.status])}</div>
          <div className="muted">{t('Объявления: {count}', { count: model.listingCount })}</div>{model.source.length > 0 && <div className="muted">{model.source.join(', ')}</div>}</div>
        <div className="admin-actions">
          <Button variant="secondary" onClick={() => setEditing({ mode: 'edit', model })}>{t('Редактировать')}</Button>
          {model.status === 'PENDING' && model.proposedBy && <>
            <Button variant="secondary" onClick={() => setEditing({ mode: 'approve', model })}>{t('Одобрить')}</Button>
            <Button variant="ghost" onClick={() => setEditing({ mode: 'merge', model })}>{t('Объединить')}</Button>
          </>}
          {(model.status !== 'PENDING' || model.proposedBy) && <Button variant="ghost" onClick={() => setEditing({ mode: 'status', model })}>{t(model.status === 'DISABLED' ? 'Включить' : 'Выключить')}</Button>}
          {model.status === 'PENDING' && !model.proposedBy && <span className="muted">{t('Рассмотрите модель в обновлениях каталога.')}</span>}
        </div>
      </li>)}
    </ul>
    {models.data?.items.length === 0 && <Notice>{t('Модели не найдены.')}</Notice>}
    <Pager page={page} limit={20} total={models.data?.total ?? 0} change={setPage} />
  </div>;
}

function MergeTarget({ families }: { families: ModelFamily[] }) {
  const { t } = useI18n();
  return <Field label={t('Объединить с моделью')}><select name="intoModelId" required>
    <option value="">{t('Выберите модель')}</option>{families.flatMap(group => group.models).filter(model => model.status === 'ACTIVE')
      .map(model => <option value={model.id} key={model.id}>{model.nameRu}</option>)}
  </select></Field>;
}

type SyncItem = { id: string; source: string; kind: string; rawName: string; modelName?: string; modelCategory?: string; externalId: string; codename: string | null;
  modelId: string | null; status: string; note: string | null; firstSeenAt: string; lastSeenAt: string };

function SyncQueue() {
  const { t, locale } = useI18n();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('PENDING');
  const [kind, setKind] = useState('');
  const [selected, setSelected] = useState<SyncItem>();
  const [decision, setDecision] = useState('');
  const [revision, setRevision] = useState(0);
  const queue = useModelData<ModelPage<SyncItem> & { pending: number }>(`/admin/catalog-sync/items?${new URLSearchParams({ status, kind, page: String(page), limit: '20' })}`, revision);
  const active = useModelData<{ families: ModelFamily[] }>(decision === 'MERGE' && selected ? modelPath(selected.modelCategory ?? 'gpu') : null);
  const date = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
  const choices = selected?.kind === 'NEW_MODEL' ? ['ACCEPT', 'MERGE', 'REJECT'] : selected?.kind === 'LINK_PCI' ? ['LINK', 'REJECT'] : ['ACK', 'REJECT'];
  return <div className="model-panel">
    <h3>{t('Ожидают проверки: {count}', { count: queue.data?.pending ?? 0 })}</h3>
    <div className="form-grid model-form">
      <Field label={t('Статус')}><select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}>
        <option value="">{t('Все статусы')}</option>{Object.entries(queueStatuses).map(([key, label]) => <option value={key} key={key}>{t(label)}</option>)}
      </select></Field>
      <Field label={t('Тип обновления')}><select value={kind} onChange={event => { setKind(event.target.value); setPage(1); }}>
        <option value="">{t('Любой')}</option>{Object.entries(modelKinds).map(([key, label]) => <option value={key} key={key}>{t(label)}</option>)}
      </select></Field>
    </div>
    {selected && <StaffForm title={selected.rawName} cancel={() => { setSelected(undefined); setDecision(''); }} done={() => {
      setSelected(undefined); setDecision(''); setRevision(current => current + 1);
    }} save={async fields => {
      const modelPatch = decision === 'ACCEPT' ? { nameRu: fields.get('nameRu'), nameEn: fields.get('nameEn') } : undefined;
      await api(`/admin/catalog-sync/items/${selected.id}/decide`, { method: 'POST', body: { decision, intoModelId: fields.get('intoModelId'), modelPatch, note: fields.get('note') } });
    }}>
      <Field label={t('Решение')}><select required value={decision} onChange={event => setDecision(event.target.value)}>
        <option value="">{t('Выберите решение')}</option>{choices.map(key => <option key={key} value={key}>{t(decisions[key])}</option>)}
      </select></Field>
      {decision === 'MERGE' && <MergeTarget families={active.data?.families ?? []} />}
      {decision === 'ACCEPT' && <div className="form-grid">
        <Field label={t('Название на русском')}><input required minLength={2} maxLength={120} name="nameRu" defaultValue={selected.modelName ?? selected.rawName} /></Field>
        <Field label={t('Название на английском')}><input required minLength={2} maxLength={120} name="nameEn" defaultValue={selected.modelName ?? selected.rawName} /></Field>
      </div>}
      <Field label={t('Примечание')}><textarea name="note" maxLength={1000} /></Field>
    </StaffForm>}
    {queue.loading && <Spinner />}{queue.error && <Notice tone="error">{t(queue.error)}</Notice>}
    <ul className="model-records">{queue.data?.items.map(item => <li key={item.id}>
      <div><strong>{item.rawName}</strong><div className="muted">{t(modelKinds[item.kind])} · {item.externalId}{item.codename ? ` · ${item.codename}` : ''}</div>
        <div className="muted">{t(queueStatuses[item.status])} · {item.modelName ?? '—'}</div><div className="muted">{date(item.firstSeenAt)} · {date(item.lastSeenAt)}</div></div>
      {item.status === 'PENDING' && <div><Button variant="secondary" onClick={() => { setSelected(item); setDecision(''); }}>{t('Рассмотреть')}</Button></div>}
    </li>)}</ul>
    {queue.data?.items.length === 0 && <Notice>{t('Обновления не найдены.')}</Notice>}
    <Pager page={page} limit={20} total={queue.data?.total ?? 0} change={setPage} />
    <p className="muted">{t('Коды ускорителей получены из базы PCI ID. Лицензия GPL-2.0-or-later или BSD-3-Clause.') } <a href="https://pci-ids.ucw.cz/" target="_blank" rel="noreferrer">PCI ID</a></p>
  </div>;
}

type SourceHealth = { etag?: string; contentBytes?: number; lastStatus?: string; lastCheckedAt?: string; lastError?: string };
type SyncSource = SourceHealth & { code: string; urls: string[]; urlChecks: (SourceHealth & { url: string })[] };

function SyncSources({ canEdit }: { canEdit: boolean }) {
  const { t, locale } = useI18n();
  const [selected, setSelected] = useState<SyncSource>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const sources = useModelData<SyncSource[]>('/admin/catalog-sync/sources', revision);
  async function run(code: string) {
    setBusy(true); setMessage(''); setError('');
    try {
      const result = await api<{ status: string }>('/admin/catalog-sync/run', { method: 'POST', body: { source: code } });
      setMessage(result.status === 'FAILED' ? 'Проверка завершилась ошибкой. Подробности указаны у источника.' : result.status === 'SKIPPED' ? 'Проверка уже выполняется.' : 'Проверка завершена.');
      setRevision(current => current + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось запустить проверку.'); }
    finally { setBusy(false); }
  }
  return <div className="model-panel">
    {sources.loading && <Spinner />}{(sources.error || error) && <Notice tone="error">{t(sources.error ?? error)}</Notice>}
    {message && <Notice>{t(message)}</Notice>}
    {selected && <StaffForm key={selected.code} title={t(codes[selected.code] ?? selected.code)} cancel={() => setSelected(undefined)} done={() => {
      setSelected(undefined); setRevision(current => current + 1);
    }} save={async fields => { await api(`/admin/catalog-sync/sources/${selected.code}`, { method: 'PUT', body: { urls: lines(fields.get('urls')) } }); }}>
      <Field label={t('HTTPS-адреса, по одному в строке')}><textarea name="urls" rows={6} required defaultValue={selected.urls.join('\n')} /></Field>
    </StaffForm>}
    <ul className="model-records">{sources.data?.map(source => <li key={source.code}>
      <div><strong>{t(codes[source.code] ?? source.code)}</strong>
        <div className="muted">{source.lastStatus ? t(checkStatuses[source.lastStatus]) : t('Ещё не проверен')}
          {source.lastCheckedAt && ` · ${new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(source.lastCheckedAt))}`}
          {source.contentBytes != null && ` · ${source.contentBytes} ${t('байт')}`}</div>
        {source.lastError && <div className="muted">{t(source.lastError)}</div>}
        <ul className="model-source-urls">{source.urlChecks.map(check => <li key={check.url}>
          {check.url}<span className="muted"> · {check.lastStatus ? t(checkStatuses[check.lastStatus]) : t('Ещё не проверен')}
            {check.contentBytes != null && ` · ${check.contentBytes} ${t('байт')}`}{check.etag && ` · ETag ${check.etag}`}
            {check.lastCheckedAt && ` · ${new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(check.lastCheckedAt))}`}
            {check.lastError && ` · ${t(check.lastError)}`}</span>
        </li>)}</ul></div>
      {canEdit && <div className="admin-actions"><Button variant="secondary" disabled={busy} onClick={() => void run(source.code)}>{t('Проверить сейчас')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setSelected(source)}>{t('Изменить адреса')}</Button></div>}
    </li>)}</ul>
  </div>;
}

function BackfillModels() {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<{ items: { listingId: string; title: string; suggestedModelId: string; matchedAlias: string }[]; hasMore: boolean }>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function preview(next: number) {
    setBusy(true); setError(''); setSelected([]);
    try { setResult(await api(`/admin/models/backfill-preview?page=${next}&limit=20`, { method: 'POST' })); setPage(next); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось проверить объявления.'); }
    finally { setBusy(false); }
  }
  async function apply() {
    setBusy(true); setError('');
    const items = result?.items.filter(item => selected.includes(item.listingId)).map(item => ({ listingId: item.listingId, modelId: item.suggestedModelId }));
    try {
      const applied = await api<{ changed: number }>('/admin/models/backfill-apply', { method: 'POST', body: { items } });
      setMessage(t('Обновлено объявлений: {count}', { count: applied.changed }));
      await preview(1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось обновить объявления.'); }
    finally { setBusy(false); }
  }
  return <div className="model-panel">
    <p>{t('Проверьте предложения моделей для объявлений со свободным вводом. Изменятся только отмеченные объявления.')}</p>
    {error && <Notice tone="error">{t(error)}</Notice>}{message && <Notice tone="success">{message}</Notice>}
    <div><Button variant="secondary" disabled={busy} onClick={() => void preview(1)}>{t('Найти предложения моделей')}</Button></div>
    {result && <>
      {result.items.length === 0 && <Notice>{t('На этой странице совпадений нет.')}</Notice>}
      <ul className="model-records">{result.items.map(item => <li key={item.listingId}>
        <label className="checkbox-label"><input type="checkbox" checked={selected.includes(item.listingId)} onChange={event => setSelected(current => event.target.checked ? [...current, item.listingId] : current.filter(id => id !== item.listingId))} />
          <span>{item.title}<br /><span className="muted">{item.suggestedModelId} · {item.matchedAlias}</span></span></label>
      </li>)}</ul>
      <div className="admin-actions"><Button variant="secondary" disabled={busy || page <= 1} onClick={() => void preview(page - 1)}>{t('Назад')}</Button>
        <Button variant="secondary" disabled={busy || !result.hasMore} onClick={() => void preview(page + 1)}>{t('Далее')}</Button>
        <Button disabled={busy || selected.length === 0} onClick={() => void apply()}>{t('Проставить отмеченные модели')}</Button></div>
    </>}
  </div>;
}
