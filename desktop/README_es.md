# DB2CRUD · Escritorio

Versión de escritorio de DB2CRUD: Python + PySide6.

Hace lo mismo que la versión web, en tu equipo y sin navegador: pasa los mismos casos de prueba de [`shared/test-cases/`](../shared/README.md) y lee los modelos exactamente igual.

Qué hace la herramienta y su filosofía están en el [README principal](../README_es.md).

## Descarga

| Sistema | Archivo |
|---|---|
| macOS (Apple Silicon) | [DB2CRUD-macOS.dmg](https://github.com/RaulEstevezA/DB2CRUD/releases/latest/download/DB2CRUD-macOS.dmg) |
| Windows (x64) | [DB2CRUD-Windows.zip](https://github.com/RaulEstevezA/DB2CRUD/releases/latest/download/DB2CRUD-Windows.zip) |
| Windows (ARM64) | [DB2CRUD-Windows-ARM64.zip](https://github.com/RaulEstevezA/DB2CRUD/releases/latest/download/DB2CRUD-Windows-ARM64.zip) |
| Linux (x64) | [DB2CRUD-Linux.tar.gz](https://github.com/RaulEstevezA/DB2CRUD/releases/latest/download/DB2CRUD-Linux.tar.gz) |
| Linux (ARM64, Ubuntu 24.04 o más nueva) | [DB2CRUD-Linux-ARM64.tar.gz](https://github.com/RaulEstevezA/DB2CRUD/releases/latest/download/DB2CRUD-Linux-ARM64.tar.gz) |

Todas las versiones están en [Releases](https://github.com/RaulEstevezA/DB2CRUD/releases). Los enlaces funcionan en cuanto se publique la primera versión.

> [!NOTE]
> La aplicación empaquetada se ha compilado y comprobado en **macOS** (Apple Silicon). Las versiones de Windows y Linux las compila GitHub Actions y pasan los tests y una prueba de arranque automática, pero nadie las ha usado todavía en un equipo real. Si encuentras algún problema, escríbeme a [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

- **macOS:** abre el `.dmg` y arrastra DB2CRUD a Aplicaciones.
- **Windows:** descomprime el `.zip` y ejecuta `DB2CRUD.exe` dentro de la carpeta `DB2CRUD`.
- **Linux:** descomprime con `tar -xzf DB2CRUD-Linux.tar.gz` (o `DB2CRUD-Linux-ARM64.tar.gz`) y ejecuta `DB2CRUD/DB2CRUD`. En algunas distribuciones hace falta instalar `libxcb-cursor0`. La versión ARM64 necesita una distribución de 2024 o más nueva (glibc 2.39, como Ubuntu 24.04).

### Abrirla la primera vez

La aplicación no está firmada (firmarla requiere cuentas de pago de Apple y Microsoft), así que el sistema avisa la primera vez que se abre:

- **macOS** dice que no ha podido verificar que la app esté libre de software malicioso. Pulsa **Hecho**, ve a **Ajustes del Sistema → Privacidad y seguridad**, baja hasta **Seguridad** y pulsa **Abrir igualmente**. Solo hay que hacerlo una vez.
- **Windows** muestra "Windows protegió su PC". Pulsa **Más información** y después **Ejecutar de todas formas**.

El código es el de este repositorio y los archivos los compila GitHub Actions ([workflow](../.github/workflows/release-desktop.yml)).

## Diferencias con la versión web

- Funciona sin conexión: no hay enlaces a las otras herramientas.

## Ejecutar en local

Requisitos: Python 3.11 o posterior.

```bash
cd desktop
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
python -m pytest                   # tests (casos compartidos de shared/test-cases/)
ruff check .                       # análisis estático
python -m db2crud                 # abrir la aplicación
```

## Generar el ejecutable

```bash
pip install -e ".[build]"
pyinstaller packaging/db2crud.spec
dist/DB2CRUD.app/Contents/MacOS/DB2CRUD --smoke-test   # macOS; dist/DB2CRUD/DB2CRUD en los demás
```

El resultado queda en `dist/`: `DB2CRUD.app` en macOS y una carpeta `DB2CRUD` con el ejecutable en Windows y Linux. PyInstaller no compila para otros sistemas: cada uno se genera en su propio sistema operativo. `--smoke-test` abre la ventana, carga todos los ejemplos y lee un documento YAML, para comprobar que no falta nada en el paquete.

## Estructura

```
db2crud/
  core/          La misma lógica que web/src/core/, módulo a módulo: modelo, importadores, análisis, decisiones
                 y exportación
  ui/            La ventana (PySide6): panel de modelos, textos y tema
  workspace.py   Lectura de la entrada, como web/src/app/workspace.ts
  examples.py    Los ejemplos incluidos, los mismos que web/src/examples/
packaging/       Spec de PyInstaller, lanzador, prueba de arranque e iconos
tests/           Casos compartidos (llamadas), la exportación y la ventana
```

## Desarrollador

**Raul Estevez**

- [Web personal](https://raulesteveza.github.io/)
- [Perfil de LinkedIn](https://www.linkedin.com/in/raulesteveza/)

## Licencia

[MIT](../LICENSE)
