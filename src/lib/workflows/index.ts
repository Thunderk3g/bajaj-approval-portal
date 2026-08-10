/**
 * The workflow engine's front door.
 *
 * Importing the hierarchy's registration here — rather than from the engine, or
 * from each caller — is what guarantees `TL_OF_SM` and `ACM_OF_SM` are known
 * before any chain that names them is materialised. A resolver registered by
 * whichever module happened to be imported first is a chain that routes correctly
 * in the app and to nobody in a test that imported the engine directly.
 */
import '@/lib/hierarchy/register';

export * from './errors';
export * from './resolvers';
export * from './chains';
export * from './routing';
export * from './engine';
