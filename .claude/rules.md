# Project Rules

## Package Manager

- Always use `yarn` instead of `npm` for installing packages and running scripts
- Examples:
  - Use `yarn add <package>` instead of `npm install <package>`
  - Use `yarn add --dev <package>` instead of `npm install --save-dev <package>`
  - Use `yarn <script>` instead of `npm run <script>`

## TypeScript Import Extensions

- Do NOT use file extensions in relative imports
- The project uses `moduleResolution: "bundler"` which handles extensions automatically
- Examples:
  - ✅ Correct: `import { foo } from './bar'`
  - ❌ Incorrect: `import { foo } from './bar.js'`
  - ❌ Incorrect: `import { foo } from './bar.ts'`
