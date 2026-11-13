/** Web/application frameworks recognised in manifests (npm and PyPI names). */
export const KNOWN_FRAMEWORKS: string[] = [
  "react",
  "next",
  "vue",
  "nuxt",
  "svelte",
  "@angular/core",
  "express",
  "fastify",
  "@nestjs/core",
  "koa",
  "hono",
  "django",
  "fastapi",
  "flask",
];

/** Database libraries and ORMs recognised in manifests; they feed `database.<name>` evidence. */
export const KNOWN_DATABASES: string[] = [
  "prisma",
  "typeorm",
  "knex",
  "sequelize",
  "drizzle-orm",
  "mongoose",
  "sqlalchemy",
  "alembic",
];

/** Test runners recognised in manifests and config files; they feed `testing.<name>` evidence. */
export const KNOWN_TEST_TOOLS: string[] = [
  "vitest",
  "jest",
  "mocha",
  "playwright",
  "cypress",
  "pytest",
];
