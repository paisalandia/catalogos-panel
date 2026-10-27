# Panel de Catálogos PDF

Página que se abre dentro de Shopify (Apps → Catálogos PDF) para ver los productos de cada catálogo
y quitarlos, volver a incluirlos, agregarlos u ordenarlos.

Es solo la página: no tiene claves ni datos de la tienda. Shopify la autoriza al abrirla desde el
admin (App Bridge, acceso directo a la API). Fuera de Shopify no muestra nada.

Los cambios se guardan en el metaobjeto `catalogo_pdf` (campos `excluir_productos`,
`incluir_productos` y `orden_productos`) y el generador del repositorio `catalogos-paisalandia`
los aplica al PDF en su siguiente ejecución.
