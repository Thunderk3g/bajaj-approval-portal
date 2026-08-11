import { Steps, type StepState } from '@/components/ui';

/**
 * The import, named once.
 *
 * Both screens of the flow render this rail, and the numbers here are the same
 * numbers the step cards carry on the review page — chip 4 and the card headed
 * "4 · Sheet and parsing options" are the same thing. Keeping the labels in one
 * array is what makes that true rather than a coincidence maintained by hand.
 *
 * The upload itself is step 1. It happens on a different route, which is exactly
 * why it belongs on the rail: an admin who has just picked a file should be able
 * to see there are five more things and roughly what they are.
 */
export const UPLOAD_STEPS = [
  'File',
  'Read',
  'Roster',
  'Sheet',
  'Mapping',
  'Commit',
] as const;

export function UploadSteps({ states, className }: { states: StepState[]; className?: string }) {
  return (
    <Steps
      className={className}
      steps={UPLOAD_STEPS.map((label, index) => ({ label, state: states[index] ?? 'todo' }))}
    />
  );
}
