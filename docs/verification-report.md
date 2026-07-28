# Memcard — Reporte de verificación funcional

**Servicio:** Memcard (cloud save service)
**Rama:** `feat/white-list` · **Fecha de ejecución:** 28 de julio de 2026
**Herramienta:** PayloadStash (imagen parcheada, ver §6)
**Alcance:** verificación de caja negra contra un stack en ejecución y un bucket S3 real

---

## 1. Resumen ejecutivo

Las tres suites de verificación pasan sin excepciones: **44 requests y 71 aserciones en
verde**. La batería unitaria del repositorio (60 tests) también pasa, y `yarn validate`
está limpio.

La verificación **no encontró ningún defecto de comportamiento en Memcard**. El único bug
detectado durante el trabajo pertenece a la herramienta de pruebas, no al servicio; está
documentado en §6 y se trabajó alrededor de él. Se corrigió además una inexactitud de
documentación en `.env.example` (§7).

| Suite | Requests | Aserciones | Resultado |
|---|---:|---:|---|
| `verify` — funcional completa | 38 | 62 | ✅ |
| `limits` — 413 y 429 | 3 | 3 | ✅ |
| `unavailable` — 503 | 3 | 6 | ✅ |
| **Total** | **44** | **71** | **✅** |

| Verificación complementaria | Resultado |
|---|---|
| `yarn test` (node:test, 60 tests / 10 suites) | ✅ |
| `yarn validate` (type-check + lint + format) | ✅ |

---

## 2. Entorno de ejecución

| Componente | Valor |
|---|---|
| Memcard | build local desde el repositorio, contenedor, puerto host `3010` |
| Token Weaver | `ghcr.io/giganticplayground/token-weaver:latest-main`, puerto host `3000` |
| Bucket S3 | `memcard-bucket` (real, región `us-east-1`) |
| `MEMCARD_ENV` | `dev` |
| `MEMCARD_KEY_PREFIX` | `custom-memcard` (valor no predeterminado, deliberado) |
| Credenciales AWS | cadena por defecto del SDK, desde `.env` |

La suite se ejecuta con `tests/verification/x-run-memcard-stash.sh`, que genera las
credenciales, levanta el stack, acuña los tokens, renderiza la suite y ejecuta PayloadStash
en un contenedor desechable.

---

## 3. Personalización del prefijo de la clave S3

Uno de los objetivos explícitos era demostrar que `MEMCARD_KEY_PREFIX` se respeta. El
bucket es compartido y ya contenía los prefijos `memcard/` y `custom-cms-prefix/`. Tras la
ejecución con `MEMCARD_KEY_PREFIX=custom-memcard`, el árbol nuevo aparece sin tocar los
existentes:

```
s3://memcard-bucket/custom-memcard/dev/my-game/player-001/state.json
s3://memcard-bucket/custom-memcard/dev/my-game/mcv-316dbccd5abe/state.json   (desechable)
```

La ruta corresponde exactamente a `${prefix}/${env}/${app}/${userId}/state.json`. El objeto
del jugador desechable se elimina al final de cada corrida.

**Limitación:** la comprobación es un listado que imprime el runner, no una aserción.
PayloadStash solo habla HTTP y no puede ver S3, de modo que un layout incorrecto no haría
fallar la suite. Ver §8.

---

## 4. Cobertura funcional

### 4.1 Autenticación y autorización

Las tres formas de credencial que Memcard acepta están activas simultáneamente durante toda
la ejecución, declaradas en `tests/verification/config/memcard-auth.yaml`.

| Estrategia | Naturaleza | Origen del secreto |
|---|---|---|
| `jwks` | RS256, verificado contra el JWKS de Token Weaver | `${env:...}` |
| `hs256` | Simétrico; los tokens los firma el propio runner | `${file:...}` (montado) |
| `static` | Cadena bearer, sin JWT ni claims | `${env:...}` |

Se ejercitan además `audience`, `appClaim`, los dos tipos de `requirements` (`scope` y
`claim_includes`), los claims de path (`whitelistClaim` / `blacklistClaim`) y una
`whitelist` inline. El emisor de la estrategia HS256 es un literal, de modo que las tres
formas de origen de valor —entorno, archivo y literal— quedan cubiertas en un solo arranque.

**Quince escenarios de rechazo**, con la distinción `401` (no verificó) frente a `403`
(verificó y aun así no procede):

| Escenario | Esperado |
|---|---|
| Sin token | 401 |
| Firma falsificada | 401 |
| Token expirado | 401 |
| `aud` incorrecto | 401 |
| Emisor no declarado | 401 |
| Token sin claim `app` en ruta de jugador | 401 |
| Token sin `sub` en ruta de jugador | 401 |
| Token estático en ruta de jugador | 403 |
| Token de jugador en ruta admin | 403 |
| HS256 sin el `scope` requerido | 403 |
| HS256 sin el `role` requerido | 403 |
| HS256 con `blacklist` que cubre la ruta admin | 403 |
| HS256 con `whitelist` que excluye la ruta admin | 403 |
| Estático fuera de su `whitelist` inline | 403 |
| Jugador RS256 con `blacklist` sobre su propia ruta | 403 |

Los dos `requirements` se aseveran por separado —con un token al que le falta solo `scope` y
otro al que le falta solo `roles`— para que un fallo identifique cuál de los dos se rompió.

### 4.2 Concurrencia optimista (ETag)

El modelo completo, en las dos familias de rutas:

| Escenario | Esperado |
|---|---|
| Lectura devuelve ETag y `lastModified` | 200 |
| Escritura condicional con el ETag vigente | 200 |
| Escritura con ETag rancio | 409 + `STATE_CONFLICT` + `currentEtag` |
| `If-None-Match` con el ETag vigente | 304 |
| `If-None-Match` con un ETag rancio | 200 |
| Jugador inexistente devuelve el ETag centinela | 200 + `ETag: 0` |
| Escritura create-only con el centinela | 200 |
| Segunda escritura create-only sobre un objeto ya existente | 409 |
| Round-trip: lo leído coincide con lo escrito, al ETag emitido | 200 |
| El mismo objeto alcanzado por una segunda estrategia admin | 200 |

Las aserciones absolutas —centinela y create-only— solo son significativas contra un jugador
que nunca ha existido. Por eso viven en las rutas admin, donde el objetivo lo elige el
llamante: el runner genera un identificador nuevo en cada corrida. En las rutas de jugador
el `sub` del token fija la identidad, así que esas aserciones están escritas para sostenerse
sea cual sea el estado previo: ninguna fija un valor de ETag, solo relaciones entre ellos.

### 4.3 Validación de entrada

| Escenario | Esperado |
|---|---|
| Segmento de clave con carácter ilegal (lectura) | 400 |
| Segmento de clave con carácter ilegal (escritura) | 400 |
| Segmento `.` | 400 |
| Segmento `..` | 400 |
| `PUT` sin `If-Match` | 400 |
| `PUT` con propiedad desconocida | 400 |
| `PUT` sin `state` | 400 |

`.` y `..` se envían percent-encoded de forma deliberada: un cliente HTTP puede normalizar
`/./` antes de que el request salga, en cuyo caso la prueba mediría al cliente y no al
servicio.

### 4.4 Límites y degradación

| Escenario | Esperado |
|---|---|
| Cuerpo por encima de `MEMCARD_MAX_BODY_BYTES` | 413 |
| Request por encima del límite de tasa | 429 |
| Lectura con S3 inalcanzable | 503 + cuerpo con `message` |
| Escritura con S3 inalcanzable | 503 + cuerpo con `message` |
| `/health` durante la caída de S3 | 200 |

Ambas suites corren sobre stacks configurados a propósito para rechazar, mediante overlays
de compose separados, porque ninguna de las dos configuraciones es razonable en uso normal.

El 503 se asevera **con cuerpo**, no solo por código: un 503 vacío o con una página HTML no
le sirve al cliente móvil que tiene que decidir si reintenta, y la diferencia entre 503 y
500 es justamente esa decisión. Que `/health` siga en 200 durante la caída confirma que el
fallo no se desbordó hasta el reporte de liveness.

---

## 5. Orden del middleware confirmado empíricamente

La suite de límites depende de una aritmética exacta, y al construirla se confirmó el orden
real: **body parser → rate limiter → autenticación**. La consecuencia no es obvia: un
request rechazado por tamaño nunca llega al limitador y por tanto **no consume presupuesto
de tasa**. Con `RATE_LIMIT_MAX=1` eso deja el segundo request dentro de la ventana y el
tercero fuera.

Se desprenden dos observaciones que no son defectos, pero conviene tener presentes:

1. Un cliente puede enviar cuerpos sobredimensionados sin consumir presupuesto de tasa. El
   costo está acotado porque el parser corta la lectura en el límite, pero el limitador no
   defiende ese camino.
2. El limitador cuenta por IP y antes de autenticar. Es la ubicación convencional y correcta
   —conviene estrangular antes de trabajar— pero implica que tráfico no autenticado consume
   el presupuesto de clientes legítimos que compartan IP.

---

## 6. Hallazgo: defecto en la herramienta de pruebas

Durante la construcción se detectó un bug en **PayloadStash 1.0.2**, ajeno a Memcard. Su
resolvedor de rutas de respuesta hace:

```python
return headers.get(path[len("headers."):].lower())
```

Convierte a minúsculas el nombre solicitado, pero nunca normaliza el diccionario de headers
de la respuesta, que conserva el casing enviado por el servidor. En consecuencia,
`headers.<name>` devuelve `None` salvo que el servidor emita ese header enteramente en
minúsculas.

**Severidad para esta verificación:** alta. Memcard envía `ETag`, y todo su modelo de
concurrencia viaja en ese header. Sin parche, cada captura y cada aserción sobre el ETag se
resolvía a `None` — y los matchers negativos (`notEquals`, `notContains`, `notMatches`,
`notIn`) **pasan** contra `None`. La primera ejecución reportó verde mientras no verificaba
nada. Solo las aserciones escritas como `exists: true` lo delataron.

Se descartó la alternativa de emitir `etag` en minúsculas desde Memcard: habría funcionado,
porque los nombres de header son insensibles a mayúsculas según RFC 9110, pero deformar la
superficie pública de un servicio para acomodar el defecto de una herramienta es el
intercambio equivocado. Se corrigió la herramienta mediante una imagen parcheada
(`tests/verification/Dockerfile.payloadstash`), cuyo build falla ruidosamente si la línea
original cambia upstream.

El reporte para el proyecto upstream, con reproducción autocontenida, está en
`tests/verification/BUG-header-capture-case.md`.

**Lección transferible:** una captura que falla en silencio convierte las aserciones
posteriores en ruido. Conviene escribir al menos una aserción `exists: true` por cada valor
capturado del que dependa el resto de una secuencia.

---

## 7. Correcciones aplicadas

Ninguna al código del servicio. Dos a documentación:

| Archivo | Corrección |
|---|---|
| `.env.example` | Describía el limitador de tasa como aplicado «on the PUT endpoint». Se aplica en realidad a todo `/v1/memcard`, cualquier método, y antes de autenticar. Quien dimensionara `RATE_LIMIT_MAX` con esa frase lo calcularía solo sobre escrituras. |
| `docs/HANDOFF.md` | Un punto abierto afirmaba que los handlers admin solo tenían humo manual. Se corrigió en su lugar para distinguir lo ahora cubierto de lo que sigue faltando: un harness *in-process*, ya que esta suite requiere Docker y AWS y no puede correr en CI. |

Se añadió además una estrategia `path-claims-player` a `dev/token-weaver/token-weaver.yaml`,
de forma puramente aditiva: dos jugadores cuyos tokens portan claims `whitelist` /
`blacklist`. Los cinco jugadores `game-client` quedan intactos, y su *ausencia* de esos
claims es precisamente lo que ejercita el caso sin restricción.

---

## 8. Fuera de alcance

Lo que esta verificación **no** cubre, y por qué:

| Área | Motivo |
|---|---|
| Layout de la clave en S3 | PayloadStash solo habla HTTP. El runner lista el árbol, pero ninguna aserción falla si el layout fuera incorrecto. |
| Escritores concurrentes reales | Todos los conflictos se fabrican reenviando un ETag rancio, no con dos clientes compitiendo. |
| Envelope almacenado (`schemaVersion`, `lastModifiedAt`) | Solo se valida indirectamente por el round-trip del `state`; nada lee el objeto en S3. |
| `pathPrefix` en el bloque `paths` | Elimina un prefijo de montaje antes de comparar; este despliegue no lo usa. |
| Estrategia `delegated` de Token Weaver, rotación de llaves JWKS | Fuera del alcance de este despliegue. |
| Superficie periférica: helmet, CORS, `/api-docs`, apagado ordenado | No aseverada. |

El primer punto es la deuda más relevante: cerrarlo implica que el runner compare el
listado contra la clave esperada en lugar de solo imprimirlo.

---

## 9. Reproducción

```bash
yarn dev:keys                            # una vez — genera la llave RSA de Token Weaver
cd tests/verification
./x-run-memcard-stash.sh                 # suite funcional completa
./x-run-memcard-stash.sh limits          # 413 + 429
./x-run-memcard-stash.sh unavailable     # 503
```

Cada corrida deja artefactos en `tests/verification/output/<etiqueta>-<timestamp>/`: el
veredicto por aserción (`report.md`), un CSV de resultados, el log de ejecución, la
configuración resuelta y el cuerpo de respuesta crudo de cada request. Código de salida `0`
si todas las aserciones pasaron, `1` si alguna falló, `9` ante un error de configuración.

Las suites `limits` y `unavailable` dejan el stack en el estado degradado que necesitaban;
volver a ejecutar la suite completa lo restaura.

Documentación detallada del diseño en `tests/verification/README.md`.
