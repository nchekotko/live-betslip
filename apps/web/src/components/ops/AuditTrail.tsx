import type { AuditAction } from '@live-betslip/protocol';
import { opsActions, useOpsStore } from '../../store/opsStore';

const actionLabel: Record<AuditAction, string> = {
  suspend: 'Приостановка',
  resume: 'Возобновление',
  auto_suspend: 'Авто-приостановка',
  auto_resume: 'Авто-возобновление',
  settle: 'Расчёт',
};

export function AuditTrail() {
  const audit = useOpsStore((s) => s.audit);
  const auditError = useOpsStore((s) => s.auditError);
  const hideSystem = useOpsStore((s) => s.hideSystemAudit);
  const entries = hideSystem ? audit.filter((e) => e.actor !== 'system') : audit;

  return (
    <section className="audit" aria-labelledby="audit-title">
      <div className="audit__head">
        <h3 id="audit-title" className="subsection-title">
          Журнал действий (audit trail)
        </h3>
        <label className="checkbox">
          <input type="checkbox" checked={hideSystem} onChange={(e) => opsActions.setHideSystemAudit(e.target.checked)} />
          <span>Только ручные действия</span>
        </label>
        <button type="button" className="link" onClick={() => void opsActions.loadAudit()}>
          Обновить
        </button>
      </div>
      {auditError ? <p className="error">Не удалось загрузить журнал: {auditError}</p> : null}
      <div className="audit__scroll">
        <table className="audit__table">
          <thead>
            <tr>
              <th scope="col">Время</th>
              <th scope="col">Кто</th>
              <th scope="col">Действие</th>
              <th scope="col">Рынки</th>
              <th scope="col">Причина</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, 100).map((e) => (
              <tr key={e.id} className={e.actor === 'system' ? 'audit__row--system' : undefined}>
                <td>{new Date(e.ts).toLocaleTimeString('ru-RU')}</td>
                <td>{e.actor}</td>
                <td>{actionLabel[e.action]}</td>
                <td title={e.marketIds.join(', ')}>
                  {e.marketIds.length === 1 ? e.marketIds[0] : `${e.marketIds.length} рынков`}
                </td>
                <td>{e.reason}</td>
              </tr>
            ))}
            {entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="muted">
                  Записей нет
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
