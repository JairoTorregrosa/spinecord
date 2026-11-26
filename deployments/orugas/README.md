# deployments/orugas

Un EV3 de orugas con un teléfono de pie al frente (su pantalla es la cara) y el sensor ultrasónico encima. Datos solamente: un archivo de robot y una sala para su gemelo.

| Archivo | Qué es |
|---|---|
| `robots/orugas.json` | El robot `orugas`: motores grandes en B (oruga izquierda) y C (oruga derecha) sincronizados como `ev3.pair`, ultrasónico en el puerto 4 (rol `distance`), sin giroscopio (el rumbo sale de los encoders). `wheel_diameter_cm` 3.5 es el diámetro efectivo de la rueda dentada con la oruga y `axle_track_cm` 13.5 la distancia entre orugas: son aproximados. Calíbralos con el robot real: `drive` 50 cm y mide; `turn` 360° y mira cuánto giró. `forward_sign`: compruébalo con un `drive` de 5 cm. El mismo archivo sirve para el robot real (`--ev3`) y su gemelo `orugas-sim` (`--twin`). |
| `worlds/sala.json` | Una sala de 200 × 150 cm con tres cajas, una zona azul `base` donde sale el robot, una zona verde `meta` y los puntos `inicio` y `meta`. `body` es la huella del robot (8.5 cm por delante del eje, 13.5 por detrás con el parachoques, 9 a cada lado) y dónde mira el ultrasónico (6 cm por delante del eje). `noise` resbala más que en ruedas. `extensions.ev3` dice qué hay en cada puerto y `extensions.view` cómo se ve en 3D: orugas, el ladrillo con la pantalla hacia delante, el teléfono, el ultrasónico sobre el teléfono, el parachoques y la etiqueta. |

Arrancar el gemelo con la vista 3D:

```sh
bun apps/local/main.ts --twin deployments/orugas/robots/orugas.json --world deployments/orugas/worlds/sala.json --view
```

y abrir `http://127.0.0.1:8769/`.
