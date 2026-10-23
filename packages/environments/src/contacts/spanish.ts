/**
 * A call through a Spanish interpreter. Once the interpreter joins, every
 * agent turn is followed by the interpreter's Spanish rendering of it, and
 * every caller turn is said in Spanish and followed by the interpreter's
 * English, in the first person, as interpreters work. The Spanish is written
 * from the same slots as the English, so a figure the interpreter says is the
 * figure the agent said, and the record's.
 *
 * A relay carries its turn's tag with `:relay` after it, so a defect planted
 * in the agent's English is planted in the interpreter's Spanish too.
 */

import type { Rng } from "../rng.js";
import { expand, type Slots } from "./grammar.js";
import type { InquiryReason } from "./types.js";
import type { DraftTurn } from "./writer.js";

const HARDSHIP_ES: Record<string, string> = {
  job_loss: "perdí mi trabajo",
  hours_cut: "me redujeron las horas en el trabajo",
  medical: "tuve una emergencia médica",
  divorce: "me estoy divorciando",
  car: "se me descompuso el carro",
  family: "tuvimos una emergencia familiar",
  business: "mi negocio ha estado lento",
  overtime: "perdí las horas extra",
};

const REASON_ES: Record<InquiryReason, string> = {
  payment_received: "[Quiero saber|Quería saber] si recibieron mi pago.",
  make_payment: "Quiero hacer un pago[ por teléfono|].",
  payment_change: "Me llegó una carta que dice que mi pago cambió y no entiendo por qué.",
  rate_change: "Me llegó una carta que dice que mi tasa de interés cambió.",
  payment_arrangement: "Sé que estoy atrasado y quiero arreglar un plan.",
  hardship: "Es que {hardship_es}, y estoy atrasado con los pagos.",
  escrow_analysis: "Recibí el análisis de la cuenta de depósito y no lo entiendo.",
  insurance: "Cambié de compañía de seguro y quiero saber a dónde mando la póliza.",
  tax: "Quiero saber si pagaron mis impuestos de la propiedad.",
  form_1098: "Necesito mi forma 1098 para los impuestos.",
  online_access: "No puedo entrar a mi cuenta en la página.",
  autopay_setup: "Quiero poner los pagos automáticos.",
  statement_copy: "Necesito una copia de mi estado de cuenta.",
  account_update: "Necesito cambiar mi información de contacto.",
  late_fee: "Me cobraron un cargo por pago tardío y no entiendo por qué.",
  payoff_request: "Necesito saber cuánto debo para liquidar el préstamo.",
  lien_release: "Ya pagué mi préstamo y no me ha llegado la liberación del gravamen.",
  servicing_transfer: "Me llegó una carta que dice que transfirieron mi préstamo.",
  disaster_assistance: "La tormenta dañó mi casa y no sé si voy a poder pagar.",
  mi_cancellation: "Quiero quitar el seguro hipotecario.",
  credit_reporting: "Mi reporte de crédito muestra un pago tarde de ustedes.",
  bankruptcy: "Me declaré en bancarrota y no sé a dónde mandar los pagos.",
};

/** The interpreter's Spanish for an agent's turn, by what the turn does. */
const AGENT_ES: Record<string, string> = {
  greeting: "Dice que gracias por llamar, que se llama {agent}, y le pregunta en qué le puede ayudar.",
  greeting_2: "Dice que se llama {agent2} y que necesita confirmar la dirección otra vez.",
  ask_for: "Pregunta por {b_full}.",
  intro: "Dice que se llama {agent} y que llama de {servicer}.",
  verify_intro: "Dice que primero necesita verificar algunos datos de la cuenta.",
  verify_ok: "Dice que gracias, que ya quedó verificado.",
  verify_authorized: "Dice que usted aparece como persona autorizada en la cuenta.",
  verify_authorization: "Dice que tienen una autorización de terceros en el archivo.",
  recording_disclosure: "Le informa que la llamada está siendo grabada.",
  mini_miranda: "Le informa que esto es un intento de cobrar una deuda y que cualquier información obtenida se usará para ese propósito.",
  bk_disclaimer: "Le informa que, como hay una bancarrota activa, esta llamada es solo informativa y no es un intento de cobrar una deuda.",
  unverified_refusal: "Dice que lo siente, pero no puede dar información de la cuenta sin verificar su identidad, y que el titular puede llamar al {phone}.",
  credit_answer: "Dice que no le puede decir que no le afectará: reportan a las agencias de crédito cada mes, y un pago con {report_days} días o más de atraso se reporta como tarde.",
  complaint_ack: "Dice que lamenta lo ocurrido y que va a registrar esto como una queja formal para que la revisen.",
  lossmit: "Dice que hay opciones de asistencia, pero que tiene que llenar una solicitud para que la revisen.",
  lossmit_package: "Dice que le va a mandar la solicitud por correo.",
  transfer: "Dice que lo va a transferir al departamento de asistencia para propietarios.",
  hold_ask: "Le pregunta si lo puede poner en espera un momento.",
  hold_return: "Dice que gracias por esperar.",
  anything_else: "Le pregunta si hay algo más en que le pueda ayudar.",
  closing: "Dice que gracias y que tenga un buen día.",
  empathy: "Dice que lo siente mucho.",
  lookup: "Dice que un momento, que está revisando la cuenta.",
  system_slow: "Dice que disculpe, que el sistema está lento.",
  purpose: "Dice que llama por el pago de su hipoteca.",
  ask_when: "Le pregunta cuándo podría hacer un pago.",
  emphasize: "Dice que es importante hacer los pagos en la fecha de vencimiento o antes.",
  interpreter_call: "",
  "quote:last_payment": "Dice que recibieron un pago de {last_amount} el {last_on_es}.",
  "quote:suspense": "Dice que {to_suspense} quedó en suspenso porque no cubría un pago completo.",
  "quote:next_payment": "Dice que su próximo pago de {next_amount} vence el {next_due_es}.",
  "quote:past_due": "Dice que la cuenta tiene {dias} de atraso y que para ponerse al corriente necesita {past_due_total}.",
  "quote:processed": "Dice que ya procesó su pago de {last_amount}.",
  "quote:analysis": "Dice que la parte del depósito cambia de {old_escrow} a {first_escrow}, y que su nuevo pago total será {new_total} a partir del {effective_es}.",
  "quote:analysis_sent": "Dice que es el análisis anual que enviaron el {sent_on_es}.",
  "quote:shortage": "Dice que hubo un faltante de {shortage} que se reparte en {spread_months} meses.",
  "quote:surplus": "Dice que hubo un sobrante de {surplus}.",
  "quote:tax_increase": "Dice que sus impuestos subieron: pagaron {tax_12m} este año, comparado con {tax_prior_12m} el año anterior.",
  "quote:hazard_increase": "Dice que el seguro también subió: {haz_12m} este año contra {haz_prior_12m} el año pasado.",
  "quote:escrow_balance": "Dice que en su último estado de cuenta el saldo del depósito era {esc_balance}.",
  "quote:arm": "Dice que su tasa cambió el {change_es}, de {prior_rate_es} a {new_rate_es}, y que su nuevo pago de capital e intereses es {new_pi}.",
  "quote:hazard_paid": "Dice que pagaron su prima de {haz_amount} el {haz_on_es}.",
  "quote:tax_paid": "Dice que pagaron {tax_amount} de impuestos el {tax_on_es}.",
  "quote:form_1098": "Dice que la forma 1098 se envió antes del {mailed_by_es} y que los intereses pagados en {year_1098} fueron {interest_1098}.",
  "quote:late_fee": "Dice que el cargo por pago tardío de {late_amount} se cobró el {late_assessed_es} porque el pago del {late_due_es} llegó después del período de gracia.",
  "quote:grace": "Dice que los pagos vencen el primero de cada mes y que tiene {grace_days} días de gracia.",
  "quote:upb": "Dice que el saldo de capital es {upb}.",
  "quote:payoff_timing": "Dice que el estado de liquidación se envía dentro de {payoff_days} días hábiles.",
  "quote:payoff_done": "Dice que el préstamo se pagó por completo el {payoff_on_es}.",
  "quote:payoff_refund": "Dice que el reembolso del depósito es de {payoff_refund}.",
  "quote:transfer": "Dice que ellos tomaron el servicio de su préstamo el {transfer_on_es} y que los términos no cambian.",
  "quote:transfer_first_due": "Dice que el primer pago para ellos es el que vence el {first_due_us_es}.",
  "quote:shield": "Dice que durante {shield_days} días después de la transferencia, un pago enviado al administrador anterior no se considera tarde.",
  "quote:loan4": "Dice que su nuevo número de préstamo termina en {loan4}.",
  "quote:mi_terminated": "Dice que el seguro hipotecario se canceló a partir del {mi_terminated_on_es}.",
  "quote:mi_rules": "Dice que puede pedir la cancelación cuando el saldo llegue al {mi_request_es} del valor original, y que se cancela sola al {mi_auto_es}.",
  "quote:credit_rule": "Dice que reportan a las agencias de crédito cada mes, y que un pago se reporta tarde solo si tiene {report_days} días o más de atraso.",
  "quote:promise": "Dice que anotó una promesa de pago de {promise_amount} para el {promise_date_es}.",
  "quote:statement": "Dice que el capital e intereses son {next_pi} y el depósito {next_escrow}.",
  "quote:reset": "Dice que le va a enviar un enlace para cambiar la contraseña, que dura {reset_minutes} minutos.",
  "quote:no_payment": "Dice que no ve ningún pago registrado después del {last_on_es}.",
};

const CALLER_ES: Record<string, readonly string[]> = {
  intro: ["Hola, sí, me llamo {caller_full}.", "Buenas, habla {caller_full}."],
  speaking: ["Sí, soy yo.", "Sí, habla {b_first}."],
  verify_fail: ["No lo sé.", "No tengo eso aquí."],
  react: ["Sí.", "Okay.", "Ajá.", "Entiendo.", "Está bien.", "Gracias."],
  backchannel: ["Ajá.", "Sí.", "Okay."],
  ask: ["¿Y eso qué quiere decir?", "¿Y puedo pagarlo ahora?", "¿Cómo hago eso?"],
  story: ["Sí, ya sé. Es que {hardship_es}."],
  credit_question: ["¿Esto va a afectar mi crédito?"],
  complaint: ["La verdad, estoy muy molesto con cómo han manejado esto. Quiero poner una queja."],
  authorize: ["Sí, puede hablar con mi esposo de la cuenta."],
  small_talk: ["Perdón, tengo a los niños aquí.", "Disculpe, estoy en el trabajo."],
  repeat_ask: ["Perdón, ¿cuánto era?"],
  closing: ["Gracias, igualmente.", "No, eso es todo, gracias."],
  promise_stated: ["Puedo pagar {promise_amount} el {promise_date_es}."],
  update: ["Es ‹new contact information›."],
  account: ["Es una cuenta de cheques. La ruta es ‹routing number› y la cuenta ‹account number›."],
  third_party: ["No está ahorita."],
  wrong_party: ["Número equivocado."],
  refuse: ["Ahorita no puedo hablar."],
  bk_notice: ["Quiero avisarles que me declaré en bancarrota."],
};

/** The interpreter's Spanish for an agent turn; a turn with figures and no frame is relayed with its figures. */
export function agentEs(r: Rng, t: DraftTurn, slots: Slots): string {
  const base = t.tag.replace(/:relay$/, "");
  const frame = AGENT_ES[base];
  if (frame !== undefined) {
    try {
      return expand(r, frame, slots);
    } catch {
      // A frame that names a figure this call lacks falls through to the figures it said.
    }
  }
  if (base === "verify") {
    const s = t.said.toLowerCase();
    if (s.includes("address")) return "Le pregunta la dirección de la propiedad.";
    if (s.includes("social")) return "Le pregunta los últimos cuatro números de su seguro social.";
    if (s.includes("birth")) return "Le pregunta su fecha de nacimiento.";
    if (s.includes("loan number")) return "Le pregunta si tiene el número de préstamo.";
    return "Le pregunta si usted aparece en el préstamo.";
  }
  const figures = t.said.match(/\$[\d,]+\.\d{2}/g) ?? [];
  if (figures.length) return `Dice que el monto es ${figures.join(" y ")}.`;
  return expand(r, "[Dice que|El representante dice que] [le está explicando la información de su cuenta|le explica los detalles|está revisando eso].");
}

export function callerEs(r: Rng, t: DraftTurn, slots: Slots): string {
  if (t.tag.startsWith("reason:")) {
    const reason = t.tag.slice("reason:".length) as InquiryReason;
    return expand(r, REASON_ES[reason] ?? "Tengo una pregunta sobre mi préstamo.", slots);
  }
  if (t.tag === "verify_answer") {
    const s = t.said;
    if (slots.ssn4 && s.includes(slots.ssn4) && slots.street && s.includes(slots.street)) return expand(r, "{street}, y los últimos cuatro son {ssn4}.", slots);
    if (slots.street && s.includes(slots.street)) return expand(r, "Es {street}, {city}.", slots);
    if (slots.ssn4 && s.includes(slots.ssn4)) return expand(r, "{ssn4}.", slots);
    if (slots.dob_y && s.includes(slots.dob_y)) return expand(r, "El {dob_es_y}.", slots);
    if (slots.loan_number && s.includes(slots.loan_number)) return expand(r, "Sí, es {loan_number}.", slots);
    return "No lo tengo aquí.";
  }
  if (t.tag === "ask" || t.tag === "clarify") {
    // The question the interpreter will put back into English, asked in Spanish.
    const s = t.said.toLowerCase();
    if (s.includes("shortage")) return "¿Y si pago el faltante, baja mi pago?";
    if (s.includes("waive") || s.includes("removed") || s.includes("first time")) return "¿Me pueden quitar ese cargo?";
    if (s.includes("dispute")) return "¿Cómo lo disputo?";
    if (s.includes("going up") || s.includes("change") || s.includes("higher")) return "¿Va a seguir subiendo?";
    if (s.includes("e-mail") || s.includes("title")) return "¿Me lo pueden mandar por correo electrónico?";
    if (s.includes("how long") || s.includes("expect")) return "¿Cuánto tiempo tarda eso?";
    if (s.includes("send you") || s.includes("all set") || s.includes("anything else")) return "¿Entonces no tengo que hacer nada más?";
    if (s.includes("what do i need")) return "¿Qué tengo que mandar?";
    return "¿Y eso qué quiere decir?";
  }
  const lines = CALLER_ES[t.tag];
  if (lines) {
    try {
      return expand(r, r.pick(lines), slots);
    } catch {
      // fall through
    }
  }
  return expand(r, "[Sí, entiendo.|Okay.|Está bien.]");
}

/** The Spanish for a hardship key, for the slots. */
export const hardshipEs = (key: string | null): string => (key ? HARDSHIP_ES[key] ?? "hemos tenido problemas" : "hemos tenido problemas");

/** Rewrite a call's turns for an interpreter, from the interpreter's arrival on. */
export function interpret(r: Rng, turns: readonly DraftTurn[], slots: Slots): DraftTurn[] {
  const out: DraftTurn[] = [];
  let joined = false;
  const piiIn = (text: string, pii: readonly string[], extra: readonly string[] = []) =>
    [...pii, ...extra].filter((x) => x && text.includes(x));
  const piiSlots = [slots.ssn4 ?? "", slots.loan_number ?? "", slots.dob_es_y ?? "", slots.dob_es ?? "", slots.phone4 ?? "", "‹routing number›", "‹account number›", "‹new contact information›", "‹e-mail address›"];
  for (const t of turns) {
    if (!joined) {
      out.push(t);
      if (t.tag === "interpreter_join") joined = true;
      continue;
    }
    if (t.speaker === "AGENT" || t.speaker === "AGENT_2") {
      out.push(t);
      const es = agentEs(r, t, slots);
      if (es) out.push({ speaker: "INTERPRETER", said: es, tag: `${t.tag}:relay`, pii: piiIn(es, t.pii, piiSlots) });
    } else if (t.speaker === "CALLER") {
      const es = callerEs(r, t, slots);
      out.push({ speaker: "CALLER", said: es, tag: t.tag, pii: piiIn(es, t.pii, piiSlots) });
      if (t.tag !== "backchannel" && t.tag !== "react") out.push({ speaker: "INTERPRETER", said: t.said, tag: `${t.tag}:relay`, pii: t.pii });
    } else out.push(t);
  }
  return out;
}
