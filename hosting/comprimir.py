import os, sys, zipfile

base, salida = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(salida, "w", zipfile.ZIP_DEFLATED) as z:
    for carpeta, _, archivos in os.walk(base):
        for nombre in archivos:
            ruta = os.path.join(carpeta, nombre)
            z.write(ruta, os.path.relpath(ruta, base).replace(os.sep, "/"))
