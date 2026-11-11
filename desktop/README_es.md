# Model2API · Escritorio

Versión de escritorio de Model2API: Python + PySide6.

Hace lo mismo que la versión web, en tu equipo y sin navegador: pasa los mismos casos de prueba de [`shared/test-cases/`](../shared/README.md), propone los mismos endpoints y escribe exactamente los mismos archivos de proyecto para cada framework y opción.

Qué hace la herramienta y su filosofía están en el [README principal](../README_es.md).

## Descarga

| Sistema | Archivo |
|---|---|
| macOS (Apple Silicon) | [Model2API-macOS.dmg](https://github.com/RaulEstevezA/Model2API/releases/latest/download/Model2API-macOS.dmg) |
| Windows (x64) | [Model2API-Windows.zip](https://github.com/RaulEstevezA/Model2API/releases/latest/download/Model2API-Windows.zip) |
| Windows (ARM64) | [Model2API-Windows-ARM64.zip](https://github.com/RaulEstevezA/Model2API/releases/latest/download/Model2API-Windows-ARM64.zip) |
| Linux (x64) | [Model2API-Linux.tar.gz](https://github.com/RaulEstevezA/Model2API/releases/latest/download/Model2API-Linux.tar.gz) |
| Linux (ARM64, Ubuntu 24.04 o más nueva) | [Model2API-Linux-ARM64.tar.gz](https://github.com/RaulEstevezA/Model2API/releases/latest/download/Model2API-Linux-ARM64.tar.gz) |

Todas las versiones están en [Releases](https://github.com/RaulEstevezA/Model2API/releases). Los enlaces funcionan en cuanto se publique la primera versión.

> [!NOTE]
> La aplicación empaquetada se ha compilado y comprobado en **macOS** (Apple Silicon). Las versiones de Windows y Linux las compila GitHub Actions y pasan los tests y una prueba de arranque automática, pero nadie las ha usado todavía en un equipo real. Si encuentras algún problema, escríbeme a [contact.raulesteveza@gmail.com](mailto:contact.raulesteveza@gmail.com).

- **macOS:** abre el `.dmg` y arrastra Model2API a Aplicaciones.
- **Windows:** descomprime el `.zip` y ejecuta `Model2API.exe` dentro de la carpeta `Model2API`.
- **Linux:** descomprime con `tar -xzf Model2API-Linux.tar.gz` (o `Model2API-Linux-ARM64.tar.gz`) y ejecuta `Model2API/Model2API`. En algunas distribuciones hace falta instalar `libxcb-cursor0`. La versión ARM64 necesita una distribución de 2024 o más nueva (glibc 2.39, como Ubuntu 24.04).

### Abrirla la primera vez

La aplicación no está firmada (firmarla requiere cuentas de pago de Apple y Microsoft), así que el sistema avisa la primera vez que se abre:

- **macOS** dice que no ha podido verificar que la app esté libre de software malicioso. Pulsa **Hecho**, ve a **Ajustes del Sistema → Privacidad y seguridad**, baja hasta **Seguridad** y pulsa **Abrir igualmente**. Solo hay que hacerlo una vez.
- **Windows** muestra "Windows protegió su PC". Pulsa **Más información** y después **Ejecutar de todas formas**.

El código es el de este repositorio y los archivos los compila GitHub Actions ([workflow](../.github/workflows/release-desktop.yml)).

## Diferencias con la versión web

- Funciona sin conexión: no hay enlaces a las otras herramientas.
- «Recordar en este equipo» guarda el trabajo en los ajustes de la aplicación, hasta que lo borres.
- **Guardar archivo**, **OpenAPI** y **Guardar .zip** preguntan dónde guardar; el proyecto completo se guarda en un `.zip`.
- Los paneles Modelos y Endpoints están uno al lado del otro y el panel Proyecto debajo; los separadores se pueden arrastrar.

## Ejecutar en local

Requisitos: Python 3.11 o posterior.

```bash
cd desktop
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
python -m pytest                   # tests (casos compartidos de shared/test-cases/)
ruff check .                       # análisis estático
python -m model2api                 # abrir la aplicación
```

## Generar el ejecutable

```bash
pip install -e ".[build]"
pyinstaller packaging/model2api.spec
dist/Model2API.app/Contents/MacOS/Model2API --smoke-test   # macOS; dist/Model2API/Model2API en los demás
```

El resultado queda en `dist/`: `Model2API.app` en macOS y una carpeta `Model2API` con el ejecutable en Windows y Linux. PyInstaller no compila para otros sistemas: cada uno se genera en su propio sistema operativo. `--smoke-test` abre la ventana, carga todos los ejemplos, escribe el proyecto de cada framework, lee un documento YAML y guarda un `.zip` y un proyecto, para comprobar que no falta nada en el paquete.

## Estructura

```
model2api/
  core/          La misma lógica que web/src/core/, módulo a módulo: modelo, importadores, análisis, diseño,
                 validación, compatibilidad, OpenAPI, generadores, exportación y proyectos
  ui/            La ventana (PySide6): paneles de modelos, endpoints y proyecto, barra de proyecto, textos y tema
  workspace.py   Lectura de la entrada, como web/src/app/workspace.ts
  examples.py    Los ejemplos incluidos, los mismos que web/src/examples/
packaging/       Spec de PyInstaller, lanzador, prueba de arranque e iconos
tests/           Casos compartidos (llamadas, salidas, variantes), las combinaciones verificadas y la ventana
```

## Desarrollador

**Raul Estevez**

- [Web personal](https://raulesteveza.github.io/)
- [Perfil de LinkedIn](https://www.linkedin.com/in/raulesteveza/)

## Licencia

[MIT](../LICENSE)
