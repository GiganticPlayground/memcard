# Guía de la estructura de `src/`

Mapa completo del código del servicio Memcard, carpeta por carpeta y archivo por archivo, con el rol de cada uno y cómo encajan.

## `src/index.ts` — punto de entrada

Construye la app Express y conecta todo **en orden**: crea el server, carga la spec OpenAPI, y aplica los middlewares en esta secuencia (el orden importa muchísimo):

`helmet` → `cors` → `express.json({ limit })` → `requestContext` → Swagger UI → rate-limit (en `/v1/memcard`) → **`authMiddleware` (en `/v1/memcard`)** → validador OpenAPI (que despacha a los controllers) → `errorHandler`. Al final arranca el `listen` y registra el apagado grácil.

---

## `src/config/` — configuración (fail-fast)

Valida el entorno **al importar**; si falta algo, el servicio no arranca.

| Archivo | Rol |
|---|---|
| `env.validation.ts` | El **esquema Zod** de todas las variables (`AWS_REGION`, `MEMCARD_S3_BUCKET`, `JWKS_URI`, etc.) con sus defaults y transformaciones. Exporta el tipo `Env`. |
| `configuration.ts` | Carga `.env` (dotenv) y corre `envSchema.safeParse(process.env)`. Si falla, lanza un error legible con cada variable inválida. |
| `index.ts` | Ejecuta `config = validateEnv()` y exporta el `config` ya tipado y validado. **Todo el código importa `config` desde aquí.** |

---

## `src/middlewares/` — el pipeline HTTP

Cada pieza intercepta la request en cadena.

| Archivo | Rol |
|---|---|
| `auth.middleware.ts` | **Verifica el JWT** contra el JWKS remoto (`jose` + `createRemoteJWKSet`, RS256). Extrae `sub`→`userId` y el claim `app`, los pega en `req.auth`. Token inválido/ausente → `401` antes de tocar S3. |
| `openapi.middleware.ts` | Crea el middleware de `express-openapi-validator`: valida cada request contra `api/openapi.yaml` y **despacha al controller** según `x-eov-operation-handler`/`x-eov-operation-id`. Aquí es donde "nacen" las rutas. |
| `error.middleware.ts` | Manejador central de errores. Traduce a JSON: `409 STATE_CONFLICT` (con `currentEtag`), `413`, `4xx`, `503`, y `500` por defecto. |
| `rate-limit.middleware.ts` | Límite de peticiones por IP (configurable, desactivado por default). |
| `request-context.middleware.ts` | Asigna un `requestId`, lo añade al contexto de logging (`logra`) y registra inicio/fin de cada request con su duración. |
| `index.ts` | Barrel que reexporta todos los middlewares. |

---

## `src/controllers/` — handlers HTTP (delgados)

Solo traducen HTTP ↔ servicio; la lógica vive en `services/`.

| Archivo | Rol |
|---|---|
| `memcardController.ts` | `getMemcardState` y `putMemcardState`. Leen `req.auth` y las cabeceras `If-None-Match`/`If-Match`, llaman a `memcardService`, ponen la cabecera `ETag` y responden. Errores → `next(error)`. |
| `healthController.ts` | `getHealth` → `{ status, timestamp, service }`. |

---

## `src/services/` — la lógica de negocio (el corazón)

| Archivo | Rol |
|---|---|
| `memcard.service.ts` | **Dominio Memcard.** Construye la key S3 `memcard/{env}/{app}/{userId}/state.json`, envuelve el estado del cliente en el envelope (`schemaVersion`, `lastModifiedAt`), aplica el límite de tamaño (`413`) y arma la respuesta. |
| `s3.service.ts` | **`S3StateStore`: la única pieza que habla con S3** (`@aws-sdk/client-s3`). Mapea la semántica condicional: `If-None-Match`→`304`, objeto inexistente→ETag centinela, `If-Match` (con centinela→`If-None-Match: *`), `412`→`409` (releyendo el ETag actual con `HeadObject`), timeouts/5xx→`503`. |
| `index.ts` | Instancia el **singleton** `memcardService = new MemcardService(new S3StateStore())`. |

> El patrón clave: el controller no sabe de S3, `MemcardService` no sabe de AWS SDK (solo conoce `S3StateStore`), y `S3StateStore` es lo único acoplado a AWS. Capas limpias.

---

## `src/utils/` — utilidades transversales

| Archivo | Rol |
|---|---|
| `http-error.ts` | Clases de error: `HttpError` (base, con `status`), `UpstreamUnavailableError` (503), `StateConflictError` (409 + `currentEtag`), `PayloadTooLargeError` (413). Se lanzan en los servicios y las renderiza el `error.middleware`. |
| `logger.ts` | El logger `logra` configurado con el nivel/estilo del `config`. |
| `shutdown.ts` | Apagado grácil: en `SIGTERM`/`SIGINT` cierra el server, espera in-flight requests y fuerza salida tras el timeout. |
| `index.ts` | Barrel de utils. |

---

## `src/types/` — tipos TypeScript

| Archivo | Rol |
|---|---|
| `schema.d.ts` | **Autogenerado** desde `api/openapi.yaml` (`yarn gen-types`). No editar a mano. |
| `api-helpers.ts` | Helpers de tipos (`ApiRequest<'op'>`, `ApiResponse<...>`) que extraen tipos del schema OpenAPI por operación. |
| `express.d.ts` | Augmenta `Express.Request` con `req.auth` (`{ userId, app }`), lo que pone `auth.middleware` y consumen los controllers. |

---

## Flujo de una petición (atando todo)

```
PUT /v1/memcard/me/state
  │
  ├─ helmet, cors, express.json (config.MEMCARD_MAX_BODY_BYTES → 413 si excede)
  ├─ requestContext        (requestId + logging)
  ├─ rate-limit            (si está activado)
  ├─ authMiddleware        (verifica JWT vía JWKS → req.auth = {userId, app})   ← src/middlewares
  ├─ openapi validator     (valida body/headers → despacha por operationId)
  │     └─► memcardController.putMemcardState                                    ← src/controllers
  │            └─► memcardService.save(app, userId, ifMatch, state)             ← src/services
  │                   ├─ check tamaño → PayloadTooLargeError (413)
  │                   └─► s3Store.putState(...)  (If-Match / 412→409)           ← src/services
  │                          └─► @aws-sdk/client-s3 → S3
  └─ errorHandler          (cualquier throw → JSON con el status correcto)      ← src/middlewares
```

---

## Por dónde seguir leyendo

- `src/services/s3.service.ts` — toda la lógica de ETags y control de concurrencia optimista.
- `src/middlewares/auth.middleware.ts` — verificación de JWT vía JWKS.
- `src/services/memcard.service.ts` — construcción de la key y envelope de estado.
