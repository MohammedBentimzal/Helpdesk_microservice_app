// Copies .env.example to .env if it does not exist yet.
import { copyFileSync, existsSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('.env already exists, leaving it untouched.');
} else {
  copyFileSync('.env.example', '.env');
  console.log('Created .env from .env.example. Review it, then run: npm run infra:up');
}
