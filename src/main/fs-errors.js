// Messages clairs pour les erreurs du système de fichiers.

/**
 * @param {{ code?: string, message?: string }} err  Erreur Node (fs)
 * @param {'save'|'open'|'export'} action
 * @returns {{ code: string, message: string }}
 */
export function describeFsError(err, action) {
  const verb = action === 'open' ? 'lire' : 'écrire';
  const code = err?.code ?? 'UNKNOWN';
  const messages = {
    ENOSPC: 'Disque plein : libère de l’espace ou choisis un autre emplacement (disque externe, autre dossier).',
    EDQUOT: 'Quota de stockage dépassé : libère de l’espace ou choisis un autre emplacement.',
    EACCES: `Permission refusée : Bandloop ne peut pas ${verb} à cet emplacement. Choisis un autre dossier (Documents, Bureau…).`,
    EPERM: `Permission refusée : Bandloop ne peut pas ${verb} à cet emplacement. Choisis un autre dossier (Documents, Bureau…).`,
    EROFS: 'Cet emplacement est en lecture seule (clé verrouillée, disque protégé…). Choisis un autre dossier.',
    ENOENT:
      action === 'open'
        ? 'Fichier introuvable : il a peut-être été déplacé, renommé ou supprimé.'
        : 'Le dossier de destination n’existe plus.',
    EBUSY: 'Le fichier est utilisé par une autre application. Ferme-la puis réessaie.',
    EISDIR: 'Cet emplacement est un dossier, pas un fichier.',
    ENAMETOOLONG: 'Le nom ou le chemin du fichier est trop long.',
    EMFILE: 'Trop de fichiers ouverts : réessaie dans un instant.',
  };
  return { code, message: messages[code] ?? `Erreur disque (${code}) : ${err?.message ?? 'inconnue'}.` };
}
