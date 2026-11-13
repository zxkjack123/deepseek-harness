/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allow: '允许',
  allowOnce: '允许一次',
  allowAlways: '始终允许',
  unavailable: '该审批请求已无法在此进程中结算，已移除卡片',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allow: 'Allow',
  allowOnce: 'Allow once',
  allowAlways: 'Always allow',
  unavailable: 'This approval can no longer be settled here, so its card was removed',
} satisfies Record<ApprovalKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'waiting': '承認待ち',
  'detail.aria': '承認の詳細',
  'escalation': 'ツール {toolName} が特権実行を要求しています',
  'reject': '拒否',
  'allow': '許可',
  'allowOnce': '1 回だけ許可',
  'allowAlways': '常に許可',
  'unavailable': 'この承認はここでは決済できなくなったため、カードを削除しました',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  waiting: 'Esperando aprobación',
  'detail.aria': 'Detalles de aprobación',
  escalation: 'La herramienta {toolName} solicita ejecución privilegiada',
  reject: 'Rechazar',
  allow: 'Permitir',
  allowOnce: 'permitir una vez',
  allowAlways: 'Permitir siempre',
  unavailable: 'Esta aprobación ya no se puede resolver aquí, así que se quitó la tarjeta',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  waiting: "En attente d'approbation",
  'detail.aria': "Détails de l'approbation",
  escalation: "L'outil {toolName} demande une exécution privilégiée",
  reject: 'Rejeter',
  allow: 'Autoriser',
  allowOnce: 'Autoriser une fois',
  allowAlways: 'Toujours autoriser',
  unavailable: 'Cette approbation ne peut plus être tranchée ici ; la carte a été retirée',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  waiting: 'Warten auf Genehmigung',
  'detail.aria': 'Einzelheiten zur Genehmigung',
  escalation: 'Tool {toolName} fordert privilegierte Ausführung an',
  reject: 'Ablehnen',
  allow: 'Erlauben',
  allowOnce: 'Einmal zulassen',
  allowAlways: 'Immer zulassen',
  unavailable: 'Diese Genehmigung kann hier nicht mehr entschieden werden; die Karte wurde entfernt',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  waiting: 'Ожидание одобрения',
  'detail.aria': 'Детали утверждения',
  escalation: 'Инструмент {toolName} запрашивает привилегированное выполнение',
  reject: 'Отклонить',
  allow: 'Разрешить',
  allowOnce: 'Разрешить один раз',
  allowAlways: 'Всегда разрешать',
  unavailable: 'Это одобрение больше нельзя подтвердить здесь; карточка удалена',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  waiting: 'Aguardando aprovação',
  'detail.aria': 'Detalhes de aprovação',
  escalation: 'A ferramenta {toolName} solicita execução privilegiada',
  reject: 'Rejeitar',
  allow: 'Permitir',
  allowOnce: 'Permitir uma vez',
  allowAlways: 'Sempre permitir',
  unavailable: 'Esta aprovação não pode mais ser resolvida aqui; o cartão foi removido',
} satisfies Record<keyof typeof en, string>
