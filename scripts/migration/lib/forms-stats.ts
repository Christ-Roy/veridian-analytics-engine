/**
 * Stats dérivées des formulaires legacy — fonctions PURES, testées en isolation.
 *
 * Le schéma bridge `Lead` a un champ `submissionsCount` que le schéma legacy
 * n'a PAS. Pendant la migration, on le RECALCULE à partir du nombre réel de
 * FormSubmission rattachées à chaque lead, plutôt que de mettre arbitrairement 1.
 */

/** Sous-ensemble d'une FormSubmission legacy utile au comptage. */
export interface SubmissionForCount {
  id: string;
  leadId: string | null;
}

/**
 * Compte les FormSubmission par `leadId`. Les submissions sans leadId
 * (formulaire anonyme, pas d'email) sont ignorées — elles ne contribuent
 * à aucun compteur de Lead.
 *
 * Retour : Map<legacyLeadId, count>. Un lead sans aucune submission n'apparaît
 * pas dans la Map → le script retombe sur le défaut 1.
 */
export function countSubmissionsPerLead(
  submissions: SubmissionForCount[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of submissions) {
    if (!s.leadId) continue;
    counts.set(s.leadId, (counts.get(s.leadId) ?? 0) + 1);
  }
  return counts;
}
