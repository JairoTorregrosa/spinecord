# deployments/orugas

Un EV3 de orugas con un teléfono de pie al frente (su pantalla es la cara) y el sensor infrarrojo encima. Datos solamente: un archivo de robot y una sala para su gemelo.

| Archivo | Qué es |
|---|---|
| `robots/orugas.json` | El robot `orugas`: motores grandes en B (oruga izquierda) y C (oruga derecha) sincronizados como `ev3.pair`, infrarrojo en el puerto 4 (rol `distance`, lee `proximity_pct`: 0 pegado, 100 lejos), sin giroscopio (el rumbo sale de los encoders). `wheel_diameter_cm` 3.5 es el diámetro efectivo de la rueda dentada con la oruga y `axle_track_cm` 13.5 la distancia entre orugas: son aproximados. Calíbralos con el robot real: `drive` 50 cm y mide; `turn` 360° y mira cuánto giró. `forward_sign`: compruébalo con un `drive` de 5 cm. `twin` es cómo está armado: `body` la huella (8.5 cm por delante del eje, 13.5 por detrás con el parachoques, 9 a cada lado) y dónde mira el infrarrojo (6 cm por delante del eje), `ev3` qué hay en cada puerto, `drive` cómo es de verdad la tracción del gemelo (rueda 3.5 cm, 13.5 cm entre orugas, y `turn_scrub` 0.2: las orugas patinan de lado y giran un 20 % menos de lo que dicen los encoders; el gemelo se mueve con estos números y el runtime planea con los de `profile`, así que calibrar `profile` corrige el gemelo como corrige el robot) y `view` cómo se ve en 3D: orugas, el ladrillo con la pantalla hacia delante, el teléfono, el infrarrojo sobre el teléfono, el parachoques y la etiqueta. El mismo archivo sirve para el robot real (`--ev3`) y su gemelo `orugas-sim` (`--twin`), en cualquier sala. |
| `worlds/sala.json` | Una sala de 200 × 150 cm con tres obstáculos: `mueble` (fijo, 45 cm de alto), `libros` (fijo y bajo, 8 cm: el infrarrojo a 19.6 cm lo ve de lejos y mira por encima de cerca) y `caja` (de cartón, 300 g: el robot la empuja), una zona azul `base` donde sale el robot, una zona verde `meta` y los puntos `inicio` y `meta`. `noise` resbala más que en ruedas; lo que pierde un giro de orugas es del robot (`twin.drive.turn_scrub`), no de la sala. No dice nada del robot: cualquier archivo de robot con `twin` corre en ella. |

Arrancar el gemelo con la vista 3D:

```sh
bun apps/local/main.ts --twin deployments/orugas/robots/orugas.json --world deployments/orugas/worlds/sala.json --view
```

y abrir `http://127.0.0.1:8769/`.
