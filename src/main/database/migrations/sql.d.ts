/**
 * TypeScript ambient declaration for Vite raw-text SQL imports (*.sql?raw).
 * Enables static bundling of SQL migration files into the Electron Main process bundle.
 */
declare module '*.sql?raw' {
  const content: string
  export default content
}
