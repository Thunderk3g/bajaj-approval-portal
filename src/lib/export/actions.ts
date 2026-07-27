'use server';

import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth/rbac';
import { fail, ok, zodFieldErrors, type ActionResult } from '@/lib/result';
import { runExport, type GeneratedExport } from './service';
import { exportFiltersSchema } from './schemas';

/**
 * Generate an export — spec section 8.
 *
 * `requireRole` is called here, not left to the /admin layout. Middleware and
 * layouts guard navigation; a Server Action is a POST endpoint anyone can hit
 * with the action id and a crafted body, so the check has to live on the
 * action itself (spec section 4.1).
 */
export async function generateExportAction(
  _previous: ActionResult<GeneratedExport> | null,
  formData: FormData,
): Promise<ActionResult<GeneratedExport>> {
  // Outside the try: AuthzError is meant to propagate to the layout, which
  // turns it into a redirect. Catching it here would render "an error occurred"
  // on a page the user has no business seeing at all.
  const actor = await requireRole('admin');

  const parsed = exportFiltersSchema.safeParse({
    batchId: formData.get('batchId'),
    smId: formData.get('smId'),
    issuedFrom: formData.get('issuedFrom'),
    issuedTo: formData.get('issuedTo'),
    correctedOnly: formData.get('correctedOnly'),
  });

  if (!parsed.success) {
    return fail('Check the filters below.', zodFieldErrors(parsed.error));
  }

  try {
    const generated = await runExport(actor, parsed.data);
    revalidatePath('/admin/exports');
    return ok(generated);
  } catch (error) {
    // The caught message can name the database host or a filesystem path; the
    // server log is the place for it, not a rendered page.
    console.error('[export] generation failed', error);
    return fail('The export could not be generated. The server log has the details.');
  }
}
