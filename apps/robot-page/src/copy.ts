// Every string a person reads on the robot page, in English and Spanish. Both sets have the same keys
// (the Copy type), so a missing translation is a type error.
import type { ConfigField } from "./config";
import type { DeviceState, PageActivity, ProblemCode, StopWhy } from "./session";
import type { RobotLink } from "../../../packages/protocol/types";

export interface Copy {
  lang: "en" | "es";
  title: string;
  lead: string;
  connect: string;
  connecting: string;
  reconnect: string;
  disconnect: string;
  stop: string;
  stopHint: string;
  setup: string;
  server: string;
  serverHint: string;
  robot: string;
  robotHint: string;
  token: string;
  tokenHint: string;
  profile: string;
  profilePaste: string;
  profileJson: string;
  profileJsonHint: string;
  noProfiles: string;
  status: string;
  link: string;
  activity: string;
  battery: string;
  batteryLow: string;
  brick: string;
  devices: string;
  noDevices: string;
  calls: string;
  noCalls: string;
  tool: string;
  reason: string;
  duration: string;
  inactive: string;
  noValue: string;
  hiddenTokenInUrl: string;
  phoneReadOnly: string;
  keepVisible: string;
  linkState: Record<RobotLink, string>;
  activityState: Record<PageActivity, string>;
  deviceState: Record<DeviceState, string>;
  problem: Record<ProblemCode, string>;
  field: Record<ConfigField, string>;
  stopWhy: Record<StopWhy, string>;
  stopped: string;
  stopNothing: string;
  detail: string;
}

const en: Copy = {
  lang: "en",
  title: "Lend your EV3",
  lead: "This page connects the EV3 on your USB cable to the server, so a model can drive it. Keep it open and visible while the robot is in use.",
  connect: "Connect EV3",
  connecting: "Connecting…",
  reconnect: "Reconnect EV3",
  disconnect: "Disconnect",
  stop: "STOP",
  stopHint: "Space or Esc",
  setup: "Connection",
  server: "Server URL",
  serverHint: "For example https://relay.example.com",
  robot: "Robot id",
  robotHint: "Empty = the id in the profile",
  token: "Token",
  tokenHint: "Kept only until you close this tab. It is never put in the address.",
  profile: "Robot profile",
  profilePaste: "Paste JSON…",
  profileJson: "Profile JSON",
  profileJsonHint: "An object {pair, hardware, profile} like the robot files of a deployment.",
  noProfiles: "The list of profiles could not be loaded. Paste the profile JSON instead.",
  status: "Status",
  link: "Link",
  activity: "Activity",
  battery: "Battery",
  batteryLow: "low",
  brick: "EV3",
  devices: "Detected devices",
  noDevices: "Connect the EV3 to see its motors and sensors.",
  calls: "Last 20 tool calls",
  noCalls: "No calls yet.",
  tool: "Tool",
  reason: "Result",
  duration: "ms",
  inactive: "other sensor mode",
  noValue: "–",
  hiddenTokenInUrl:
    "The address had a token in it. It was ignored and removed: a token in an address ends up in the browser history. Type it in the Token field.",
  phoneReadOnly: "On a phone this page is read-only: connect the EV3 from Chrome or Edge on a computer.",
  keepVisible:
    "Keep this tab visible, in its own window if you need another tab: the browser slows down hidden tabs and this page stops the motors after 3 s hidden.",
  linkState: { offline: "offline", handshaking: "handshaking", online: "online" },
  activityState: { idle: "idle", busy: "running", stopping: "stopping" },
  deviceState: {
    unsupported: "not supported in this browser",
    none: "not connected",
    opening: "opening…",
    ready: "connected",
    lost: "unplugged",
  },
  problem: {
    webhid_unsupported:
      "This browser cannot talk to USB devices (no WebHID). Open this page in Chrome or Edge on Windows or macOS. Firefox and Safari do not work.",
    device_busy:
      "The EV3 could not be opened: another program is using it. Close the LEGO app, EV3 Classroom, other tabs with this page or anything else connected to the brick, then try again.",
    not_ev3: "The chosen device is not an EV3. Choose the one called “EV3” or “LEGO”.",
    device_error: "The browser did not give access to the EV3.",
    brick_silent:
      "The EV3 was opened but does not answer. Check that it is on, that the cable is firmly in, and try again.",
    config: "The robot profile was rejected.",
    relay_refused:
      "The server refused this robot and the page stopped retrying. Check the token, the robot id and the profile, and that no other page is lending the same robot. Then reconnect.",
    stop_unverified:
      "STOP could not confirm that the motors stopped. Lift the robot or unplug the motors, then check the cable and the brick.",
  },
  field: { server: "Server URL", robot: "Robot id", token: "Token", profile: "Robot profile" },
  stopWhy: {
    local: "STOP pressed here",
    hidden: "tab hidden for more than 3 s",
    pagehide: "page closed",
    relay: "stop from the server",
    heartbeat_lost: "server heartbeat lost",
    socket_closed: "connection to the server closed",
  },
  stopped: "Motors stopped",
  stopNothing: "No EV3 is connected to this page, so there is nothing to stop here.",
  detail: "Detail",
};

const es: Copy = {
  lang: "es",
  title: "Presta tu EV3",
  lead: "Esta página conecta el EV3 que tienes por cable USB con el servidor, para que un modelo lo pueda manejar. Déjala abierta y a la vista mientras se usa el robot.",
  connect: "Conectar EV3",
  connecting: "Conectando…",
  reconnect: "Reconectar EV3",
  disconnect: "Desconectar",
  stop: "PARAR",
  stopHint: "Espacio o Esc",
  setup: "Conexión",
  server: "URL del servidor",
  serverHint: "Por ejemplo https://relay.example.com",
  robot: "Id del robot",
  robotHint: "Vacío = el id del perfil",
  token: "Token",
  tokenHint: "Se guarda solo hasta que cierres esta pestaña. Nunca se pone en la dirección.",
  profile: "Perfil del robot",
  profilePaste: "Pegar JSON…",
  profileJson: "JSON del perfil",
  profileJsonHint: "Un objeto {pair, hardware, profile} como los archivos de robot de un deployment.",
  noProfiles: "No se pudo cargar la lista de perfiles. Pega el JSON del perfil.",
  status: "Estado",
  link: "Enlace",
  activity: "Actividad",
  battery: "Batería",
  batteryLow: "baja",
  brick: "EV3",
  devices: "Dispositivos detectados",
  noDevices: "Conecta el EV3 para ver sus motores y sensores.",
  calls: "Últimas 20 llamadas",
  noCalls: "Todavía no hay llamadas.",
  tool: "Herramienta",
  reason: "Resultado",
  duration: "ms",
  inactive: "otro modo del sensor",
  noValue: "–",
  hiddenTokenInUrl:
    "La dirección traía un token. Se ignoró y se quitó: un token en la dirección queda en el historial del navegador. Escríbelo en el campo Token.",
  phoneReadOnly: "En el celular esta página es solo de lectura: conecta el EV3 desde Chrome o Edge en un computador.",
  keepVisible:
    "Deja esta pestaña a la vista, en su propia ventana si necesitas otra pestaña: el navegador frena las pestañas ocultas y esta página para los motores a los 3 s de estar oculta.",
  linkState: { offline: "sin conexión", handshaking: "saludando", online: "en línea" },
  activityState: { idle: "en reposo", busy: "ejecutando", stopping: "parando" },
  deviceState: {
    unsupported: "no compatible con este navegador",
    none: "sin conectar",
    opening: "abriendo…",
    ready: "conectado",
    lost: "desenchufado",
  },
  problem: {
    webhid_unsupported:
      "Este navegador no puede hablar con dispositivos USB (no tiene WebHID). Abre esta página en Chrome o Edge, en Windows o macOS. Firefox y Safari no sirven.",
    device_busy:
      "No se pudo abrir el EV3: otro programa lo está usando. Cierra la app de LEGO, EV3 Classroom, otras pestañas con esta página o cualquier cosa conectada al ladrillo, y vuelve a intentar.",
    not_ev3: "El dispositivo elegido no es un EV3. Elige el que se llama “EV3” o “LEGO”.",
    device_error: "El navegador no dio acceso al EV3.",
    brick_silent:
      "El EV3 se abrió pero no responde. Revisa que esté encendido y que el cable esté bien puesto, y vuelve a intentar.",
    config: "El perfil del robot fue rechazado.",
    relay_refused:
      "El servidor rechazó este robot y la página dejó de reintentar. Revisa el token, el id del robot y el perfil, y que no haya otra página prestando el mismo robot. Después reconecta.",
    stop_unverified:
      "PARAR no pudo confirmar que los motores se detuvieron. Levanta el robot o desenchufa los motores, y revisa el cable y el ladrillo.",
  },
  field: { server: "URL del servidor", robot: "Id del robot", token: "Token", profile: "Perfil del robot" },
  stopWhy: {
    local: "PARAR oprimido aquí",
    hidden: "pestaña oculta más de 3 s",
    pagehide: "página cerrada",
    relay: "parada pedida por el servidor",
    heartbeat_lost: "se perdió el latido del servidor",
    socket_closed: "se cerró la conexión con el servidor",
  },
  stopped: "Motores detenidos",
  stopNothing: "No hay un EV3 conectado a esta página, así que aquí no hay nada que parar.",
  detail: "Detalle",
};

export const COPY = { en, es } as const;
/** Spanish for any Spanish locale, English otherwise. */
export function pickCopy(language: string | undefined): Copy {
  return (language ?? "").toLowerCase().startsWith("es") ? es : en;
}
