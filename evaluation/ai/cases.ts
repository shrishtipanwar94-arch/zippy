// THE LABELLED SET — 108 breakdown descriptions and the fault each one turned
// out to be.
//
// WHERE THESE CAME FROM, stated plainly because it is the single most
// important caveat on every number this harness prints: they are HAND-WRITTEN
// by the maintainer, modelled on how drivers in Bengaluru actually phone a
// breakdown in — romanised Hindi, English, and the two in one sentence — and
// labelled by the maintainer with the fault the description was written to
// describe. They are NOT field data, and nobody has verified that a mechanic
// attending these calls would agree with the label.
//
// That has a specific consequence for the accuracy numbers: a set written by
// the same person who wrote the prompt is a set the prompt is unconsciously
// tuned to. Read top1Accuracy here as "can the pipeline recover a fault from a
// description that contains it", not as "how often is Zippy right about a real
// breakdown". Replacing this file with transcripts of real calls is the single
// highest-value thing anybody could do to this evaluation. Recorded as a
// weakness.
//
// AMBIGUITY IS DELIBERATE AND IS THE POINT. Several descriptions genuinely
// cannot be resolved to one fault from words alone — a battery that is flat
// and a battery that has failed sound identical over the phone, and only a
// meter tells them apart. Those cases are what top2Recall and the calibration
// error exist to measure. A set where every case had one obvious answer would
// report a beautiful ECE and prove nothing.

import type { FaultCode } from '../../src/domain/faults.js';

export type LabelledCase = {
  id: string;
  text: string;
  // What the fault actually was. One label per case: a distribution over
  // labels would be more honest still, and is more than this harness needs.
  fault: FaultCode;
  language: 'EN' | 'HI' | 'MIX';
};

export const CASES: LabelledCase[] = [
  // ---- FLAT_BATTERY — dead from lights left on, cranks nothing, clicks. ----
  { id: 'fb-1', text: 'Bhai gaadi start nahi ho rahi, sirf tik-tik awaaz aa rahi hai aur engine bilkul nahi ghoom raha', fault: 'FLAT_BATTERY', language: 'HI' },
  { id: 'fb-2', text: 'I left the headlights on all night and now the car is completely dead, just clicking when I turn the key', fault: 'FLAT_BATTERY', language: 'EN' },
  { id: 'fb-3', text: 'Dashboard lights are very dim and the engine will not turn over at all. Gaadi kal tak theek thi.', fault: 'FLAT_BATTERY', language: 'MIX' },
  { id: 'fb-4', text: 'Car ne start hona band kar diya, ek click hoti hai bas. Battery light bhi aa rahi hai dashboard pe.', fault: 'FLAT_BATTERY', language: 'HI' },
  { id: 'fb-5', text: 'Nothing happens when I turn the key except a rapid clicking sound. Interior light is very weak.', fault: 'FLAT_BATTERY', language: 'EN' },
  { id: 'fb-6', text: 'Parking me khadi thi do din se, ab bilkul dead hai. Koi awaaz nahi, engine nahi ghoomta.', fault: 'FLAT_BATTERY', language: 'HI' },
  { id: 'fb-7', text: 'The car will not start, I need a jump start. It was fine yesterday, I think the battery drained.', fault: 'FLAT_BATTERY', language: 'EN' },
  { id: 'fb-8', text: 'Door kholte hi beep beep ho raha tha raat bhar, ab starter click karta hai but gaadi start nahi hoti', fault: 'FLAT_BATTERY', language: 'HI' },
  { id: 'fb-9', text: 'Engine does not crank, only a click. Car is in the basement parking of my building.', fault: 'FLAT_BATTERY', language: 'EN' },

  // ---- FAILED_BATTERY — the same symptoms, but it has stopped holding. ----
  { id: 'fbd-1', text: 'Battery teen saal purani hai, roz jump start karna padta hai, aaj to jump ke baad bhi band ho gayi', fault: 'FAILED_BATTERY', language: 'HI' },
  { id: 'fbd-2', text: 'This is the third time this week the car has not started in the morning. Needs a new battery I think.', fault: 'FAILED_BATTERY', language: 'EN' },
  { id: 'fbd-3', text: 'Jump start se chal jaati hai but engine band karte hi phir dead. Battery replace karni padegi shayad.', fault: 'FAILED_BATTERY', language: 'MIX' },
  { id: 'fbd-4', text: 'Car is completely dead again, we jump started it two days ago and it has happened again', fault: 'FAILED_BATTERY', language: 'EN' },
  { id: 'fbd-5', text: 'Purani battery hai, ab bilkul charge nahi rakhti. Aaj subah se start hi nahi ho rahi, click bhi nahi.', fault: 'FAILED_BATTERY', language: 'HI' },
  { id: 'fbd-6', text: 'No power at all, no lights, no clicking. The battery is four years old and has been weak for a month.', fault: 'FAILED_BATTERY', language: 'EN' },
  { id: 'fbd-7', text: 'Battery ki warning light aati thi kai din se, aaj gaadi start hi nahi ho rahi, engine nahi ghoomta', fault: 'FAILED_BATTERY', language: 'HI' },
  { id: 'fbd-8', text: 'The battery keeps dying. Today there is nothing at all, not even the dashboard coming on.', fault: 'FAILED_BATTERY', language: 'EN' },
  { id: 'fbd-9', text: 'Har subah battery down mil rahi hai, aaj jump cable se bhi nahi chali. Nayi battery chahiye lagta hai.', fault: 'FAILED_BATTERY', language: 'HI' },

  // ---- ALTERNATOR_FAILURE — the brief's own example lives here. ----
  { id: 'alt-1', text: 'Bhai gaadi start nahi ho rahi, pehle ek khatakhat awaaz aayi thi aur ab dashboard pe battery ka light aa raha hai', fault: 'ALTERNATOR_FAILURE', language: 'HI' },
  { id: 'alt-2', text: 'The battery warning light came on while driving and then the car lost power and stopped. There was a whining noise before.', fault: 'ALTERNATOR_FAILURE', language: 'EN' },
  { id: 'alt-3', text: 'Chalte chalte battery ka light jal gaya, phir headlight dheemi ho gayi aur gaadi band ho gayi beech road pe', fault: 'ALTERNATOR_FAILURE', language: 'HI' },
  { id: 'alt-4', text: 'A high pitched whine from the engine bay for two days, now the battery light is on and the car has died', fault: 'ALTERNATOR_FAILURE', language: 'EN' },
  { id: 'alt-5', text: 'Battery nayi hai but phir bhi battery warning aa raha hai aur AC ki hawa kam ho gayi. Ab gaadi band.', fault: 'ALTERNATOR_FAILURE', language: 'MIX' },
  { id: 'alt-6', text: 'Belt jaisi awaaz aa rahi thi, whining type, ab charging light on hai aur engine ghoomta hai but start nahi hota', fault: 'ALTERNATOR_FAILURE', language: 'HI' },
  { id: 'alt-7', text: 'Everything electrical started dimming while I was driving, then the battery symbol lit up and it cut out', fault: 'ALTERNATOR_FAILURE', language: 'EN' },
  { id: 'alt-8', text: 'Replaced the battery last month and the battery light is on again with a squealing belt noise', fault: 'ALTERNATOR_FAILURE', language: 'EN' },
  { id: 'alt-9', text: 'Dashboard pe battery ka nishaan aur saath me whining sound. Gaadi ab chalti nahi hai, service road pe khadi hai.', fault: 'ALTERNATOR_FAILURE', language: 'HI' },

  // ---- STARTER_MOTOR — grinding, or one heavy clunk and nothing. ----
  { id: 'st-1', text: 'Chaabi ghumate hi ghar ghar ki metal wali awaaz aati hai, engine start nahi hota. Battery bilkul theek hai.', fault: 'STARTER_MOTOR', language: 'HI' },
  { id: 'st-2', text: 'There is a horrible grinding noise when I turn the key and the engine does not start. Lights are all bright.', fault: 'STARTER_MOTOR', language: 'EN' },
  { id: 'st-3', text: 'Battery nayi hai, headlight full bright hai, but key ghumane pe sirf grinding sound aur engine nahi ghoomta', fault: 'STARTER_MOTOR', language: 'MIX' },
  { id: 'st-4', text: 'Sometimes it starts if I try five or six times, today it just grinds. Engine warning light is on too.', fault: 'STARTER_MOTOR', language: 'EN' },
  { id: 'st-5', text: 'Ek bhaari sa thak ki awaaz aati hai aur uske baad kuch nahi. Dashboard ki saari lights normal hain.', fault: 'STARTER_MOTOR', language: 'HI' },
  { id: 'st-6', text: 'Metal on metal scraping when starting, then nothing. It has been getting worse for a week.', fault: 'STARTER_MOTOR', language: 'EN' },
  { id: 'st-7', text: 'Gaadi ko dhakka dene pe chal jaati hai but chaabi se sirf grinding awaaz aati hai, engine nahi ghoomta', fault: 'STARTER_MOTOR', language: 'HI' },
  { id: 'st-8', text: 'The starter makes a loud grinding whirr but the engine never turns. Battery was tested fine last week.', fault: 'STARTER_MOTOR', language: 'EN' },
  { id: 'st-9', text: 'Check engine light on hai aur start karte waqt ghar-ghar wali awaaz. Gaadi highway ke shoulder pe khadi hai.', fault: 'STARTER_MOTOR', language: 'MIX' },

  // ---- OUT_OF_FUEL — cranks fine, will not fire, gauge on empty. ----
  { id: 'fu-1', text: 'Petrol khatam ho gaya lagta hai, meter bilkul empty pe hai aur gaadi beech road me band ho gayi', fault: 'OUT_OF_FUEL', language: 'HI' },
  { id: 'fu-2', text: 'The fuel gauge is on empty and the engine turns over fine but will not fire. I misjudged the distance.', fault: 'OUT_OF_FUEL', language: 'EN' },
  { id: 'fu-3', text: 'Engine ghoom raha hai but start nahi ho raha, fuel light kaafi der se on tha. Diesel khatam lagta hai.', fault: 'OUT_OF_FUEL', language: 'MIX' },
  { id: 'fu-4', text: 'Ran out of petrol on the flyover, the car cranks but there is nothing left in the tank', fault: 'OUT_OF_FUEL', language: 'EN' },
  { id: 'fu-5', text: 'Reserve me chala raha tha, ab gaadi jhatke ke saath band ho gayi. Engine ghoomta hai, chalti nahi.', fault: 'OUT_OF_FUEL', language: 'HI' },
  { id: 'fu-6', text: 'It spluttered and lost power and now it cranks but never catches. The needle is below the red line.', fault: 'OUT_OF_FUEL', language: 'EN' },
  { id: 'fu-7', text: 'Tank khali hai, pump tak nahi pahuncha. Starter ghoom raha hai lekin engine chalu nahi ho raha.', fault: 'OUT_OF_FUEL', language: 'HI' },
  { id: 'fu-8', text: 'Fuel warning was on for twenty kilometres and now the car has stopped. It turns over but does not start.', fault: 'OUT_OF_FUEL', language: 'EN' },
  { id: 'fu-9', text: 'Petrol khatam, gaadi service road pe khadi hai, engine crank ho raha hai bas start nahi hota', fault: 'OUT_OF_FUEL', language: 'HI' },

  // ---- FLAT_TYRE — unambiguous, and the reason intake asks nothing. ----
  { id: 'ty-1', text: 'Tyre punctured ho gaya hai, agla left wala. Stepney hai but jack nahi hai mere paas.', fault: 'FLAT_TYRE', language: 'HI' },
  { id: 'ty-2', text: 'I have a flat tyre on the front passenger side, I hit a pothole and heard a bang', fault: 'FLAT_TYRE', language: 'EN' },
  { id: 'ty-3', text: 'Ek zor ka dhamaka hua aur gaadi ek taraf khinchne lagi, peeche wala tyre bilkul flat hai', fault: 'FLAT_TYRE', language: 'HI' },
  { id: 'ty-4', text: 'Rear left tyre is completely flat. The car is on the hard shoulder of the ORR.', fault: 'FLAT_TYRE', language: 'EN' },
  { id: 'ty-5', text: 'Tyre ki hawa nikal gayi hai, gaadi chal nahi sakti. Spare tyre hai lekin badal nahi paunga.', fault: 'FLAT_TYRE', language: 'HI' },
  { id: 'ty-6', text: 'Puncture, front right. There was a loud bang and then a thumping noise as I pulled over.', fault: 'FLAT_TYRE', language: 'EN' },
  { id: 'ty-7', text: 'Kaanch ya keel lag gaya lagta hai, tyre puri tarah bethi hui hai. Parking lot me hoon.', fault: 'FLAT_TYRE', language: 'HI' },
  { id: 'ty-8', text: 'Flat tyre, no spare in the car. I am parked in the service lane near Silk Board.', fault: 'FLAT_TYRE', language: 'MIX' },
  { id: 'ty-9', text: 'Tyre burst ho gaya highway pe, main lane me hi khadi hai gaadi, traffic tez hai aur mujhe dar lag raha hai', fault: 'FLAT_TYRE', language: 'HI' },

  // ---- KEYS_LOCKED_IN — nothing wrong with the vehicle at all. ----
  { id: 'lo-1', text: 'Chaabi gaadi ke andar hi reh gayi aur darwaza lock ho gaya. Bacha bhi andar hai, jaldi aao.', fault: 'KEYS_LOCKED_IN', language: 'HI' },
  { id: 'lo-2', text: 'I have locked my keys inside the car. The car is fine, I just cannot get in.', fault: 'KEYS_LOCKED_IN', language: 'EN' },
  { id: 'lo-3', text: 'Boot band karte waqt chaabi andar chhod di, ab sab darwaze lock hain. Gaadi bilkul theek hai.', fault: 'KEYS_LOCKED_IN', language: 'HI' },
  { id: 'lo-4', text: 'Keys are on the driver seat and the doors auto locked. I am in the mall basement parking.', fault: 'KEYS_LOCKED_IN', language: 'EN' },
  { id: 'lo-5', text: 'Andar band ho gayi chaabi, koi spare nahi hai ghar pe. Darwaza kholna hai bas.', fault: 'KEYS_LOCKED_IN', language: 'HI' },
  { id: 'lo-6', text: 'Locked out of my own car, the key is inside in the cup holder. Nothing is wrong mechanically.', fault: 'KEYS_LOCKED_IN', language: 'EN' },
  { id: 'lo-7', text: 'Gaadi lock ho gayi aur chaabi seat pe hai. Meri maa andar baithi hain, unko garmi lag rahi hai.', fault: 'KEYS_LOCKED_IN', language: 'HI' },
  { id: 'lo-8', text: 'Shut the door with the keys in the ignition. Need someone to open it, the engine is not running.', fault: 'KEYS_LOCKED_IN', language: 'EN' },
  { id: 'lo-9', text: 'Chaabi andar, main bahar. Service road pe khadi hai gaadi, koi khatra nahi hai.', fault: 'KEYS_LOCKED_IN', language: 'HI' },

  // ---- KEY_FAILURE — the key or immobiliser, not the battery. ----
  { id: 'kf-1', text: 'Remote se lock nahi khul raha aur chaabi ghumane pe kuch nahi hota, dashboard pe chaabi ka nishaan blink kar raha hai', fault: 'KEY_FAILURE', language: 'HI' },
  { id: 'kf-2', text: 'The key fob is not being recognised, the immobiliser symbol flashes and the car will not start at all', fault: 'KEY_FAILURE', language: 'EN' },
  { id: 'kf-3', text: 'Push button start hai, key detected nahi ho rahi. Bilkul silent hai, koi awaaz nahi aati.', fault: 'KEY_FAILURE', language: 'MIX' },
  { id: 'kf-4', text: 'I lost my only key and the spare has never been programmed. The car is locked and cannot be started.', fault: 'KEY_FAILURE', language: 'EN' },
  { id: 'kf-5', text: 'Chaabi ka fob toot gaya hai, ab gaadi start hi nahi hoti, koi crank nahi, sirf key light blink karti hai', fault: 'KEY_FAILURE', language: 'HI' },
  { id: 'kf-6', text: 'Car says key not detected on the display. It is completely silent when I press start, no cranking.', fault: 'KEY_FAILURE', language: 'EN' },
  { id: 'kf-7', text: 'Duplicate chaabi banwayi thi, wo kaam nahi kar rahi. Gaadi start nahi hoti, engine bilkul nahi ghoomta.', fault: 'KEY_FAILURE', language: 'HI' },
  { id: 'kf-8', text: 'Immobiliser warning is lit and the engine will not crank. Replacing the fob battery did not help.', fault: 'KEY_FAILURE', language: 'EN' },
  { id: 'kf-9', text: 'Smart key kaam nahi kar rahi, gaadi ko chaabi hi nahi mil rahi. Silent hai, ek awaaz tak nahi.', fault: 'KEY_FAILURE', language: 'HI' },

  // ---- ENGINE_OVERHEAT — steam, temperature lamp, still drivable-ish. ----
  { id: 'oh-1', text: 'Bonnet se dhuan nikal raha hai aur temperature ka meter full red me hai, maine gaadi rok di hai', fault: 'ENGINE_OVERHEAT', language: 'HI' },
  { id: 'oh-2', text: 'Steam is coming from under the bonnet and the temperature warning light is red. I pulled over immediately.', fault: 'ENGINE_OVERHEAT', language: 'EN' },
  { id: 'oh-3', text: 'Engine bahut garam ho gaya hai, coolant leak ho raha hai neeche. Gaadi abhi bhi chal sakti hai shayad.', fault: 'ENGINE_OVERHEAT', language: 'MIX' },
  { id: 'oh-4', text: 'Temperature gauge went to maximum in traffic and there is a sweet burning smell from the engine', fault: 'ENGINE_OVERHEAT', language: 'EN' },
  { id: 'oh-5', text: 'Radiator se paani ubal raha hai, garmi ki warning light on hai. Traffic me phas gaya tha ek ghante se.', fault: 'ENGINE_OVERHEAT', language: 'HI' },
  { id: 'oh-6', text: 'The heat warning came on and the engine started making a knocking sound, I have switched it off', fault: 'ENGINE_OVERHEAT', language: 'EN' },
  { id: 'oh-7', text: 'Coolant ka puddle bana hua hai gaadi ke neeche aur temperature light red hai. Gaadi thodi chal rahi hai.', fault: 'ENGINE_OVERHEAT', language: 'HI' },
  { id: 'oh-8', text: 'White smoke and a hot smell after climbing the flyover. Temperature needle is right at the top.', fault: 'ENGINE_OVERHEAT', language: 'EN' },
  { id: 'oh-9', text: 'Garam ho gaya engine, bhaap nikal rahi hai. Main highway ke kinare shoulder pe khada hoon, akela hoon.', fault: 'ENGINE_OVERHEAT', language: 'HI' },

  // ---- BRAKE_FAILURE — the one nobody should be driving. ----
  { id: 'br-1', text: 'Brake pedal ekdum neeche tak chala jaa raha hai aur brake ki warning light on hai, gaadi rok di hai maine', fault: 'BRAKE_FAILURE', language: 'HI' },
  { id: 'br-2', text: 'The brake pedal has gone soft and goes to the floor. The brake warning light is on. I am not driving it.', fault: 'BRAKE_FAILURE', language: 'EN' },
  { id: 'br-3', text: 'Brake lagane pe metal wali grinding awaaz aati hai aur gaadi rukti nahi theek se. Bahut dar lag raha hai.', fault: 'BRAKE_FAILURE', language: 'HI' },
  { id: 'br-4', text: 'Loud grinding from the front wheels whenever I brake and the pedal vibrates badly. Brake fluid light came on.', fault: 'BRAKE_FAILURE', language: 'EN' },
  { id: 'br-5', text: 'Brake fluid leak ho raha hai, pedal bilkul soft hai. Gaadi chalane layak nahi hai.', fault: 'BRAKE_FAILURE', language: 'MIX' },
  { id: 'br-6', text: 'There is no resistance in the brake pedal at all. I coasted to a stop using the handbrake.', fault: 'BRAKE_FAILURE', language: 'EN' },
  { id: 'br-7', text: 'Brake dabane pe ghar-ghar awaaz aur pedal neeche tak jaata hai. Main live lane me khada hoon, jaldi aao.', fault: 'BRAKE_FAILURE', language: 'HI' },
  { id: 'br-8', text: 'Brake warning lamp lit up and the car pulls hard to one side when stopping. I have parked it.', fault: 'BRAKE_FAILURE', language: 'EN' },
  { id: 'br-9', text: 'Brake fail ho gaye lagta hai, pedal me kuch feel hi nahi ho raha. Gaadi ab bilkul nahi chalaunga.', fault: 'BRAKE_FAILURE', language: 'HI' },

  // ---- EV_HV_FAULT — the one that needs a certification. ----
  { id: 'ev-1', text: 'Meri electric gaadi hai, dashboard pe EV system ka red warning aa gaya aur gaadi bilkul band ho gayi', fault: 'EV_HV_FAULT', language: 'HI' },
  { id: 'ev-2', text: 'My EV has thrown a high voltage system fault and shut down completely. There is a burning smell.', fault: 'EV_HV_FAULT', language: 'EN' },
  { id: 'ev-3', text: 'Nexon EV hai, charging ke baad se EV system error dikha raha hai, ready light nahi aa rahi', fault: 'EV_HV_FAULT', language: 'MIX' },
  { id: 'ev-4', text: 'Electric car, the propulsion system warning is on and it will not move. No noise at all when I press start.', fault: 'EV_HV_FAULT', language: 'EN' },
  { id: 'ev-5', text: 'EV ka battery system fault aa raha hai, gaadi turtle mode me chali gayi thi phir band ho gayi', fault: 'EV_HV_FAULT', language: 'HI' },
  { id: 'ev-6', text: 'High voltage warning triangle on the dash of my electric car and a smell of burning plastic', fault: 'EV_HV_FAULT', language: 'EN' },
  { id: 'ev-7', text: 'Electric gaadi charge pe lagi thi, ab EV system ki warning aa rahi hai aur chalti nahi hai', fault: 'EV_HV_FAULT', language: 'HI' },
  { id: 'ev-8', text: 'The EV shows a red battery system error and refuses to go into drive. It is silent, nothing cranks.', fault: 'EV_HV_FAULT', language: 'EN' },
  { id: 'ev-9', text: 'MG ZS EV, HV system fault ka message aa raha hai aur gaadi highway lane me band ho gayi hai', fault: 'EV_HV_FAULT', language: 'MIX' },

  // ---- IMMOBILISED_UNKNOWN — an accident, or a car that cannot be moved. ----
  { id: 'im-1', text: 'Accident ho gaya hai, aage se gaadi kaafi damage hai aur wheel tedha ho gaya hai, hil nahi rahi', fault: 'IMMOBILISED_UNKNOWN', language: 'HI' },
  { id: 'im-2', text: 'I have been hit from behind, the rear wheel is bent and the car cannot be driven at all', fault: 'IMMOBILISED_UNKNOWN', language: 'EN' },
  { id: 'im-3', text: 'Gaadi gadde me phas gayi hai, neeche se kuch tak gaya hai aur ab aage peeche nahi ho rahi', fault: 'IMMOBILISED_UNKNOWN', language: 'HI' },
  { id: 'im-4', text: 'There was a loud bang from underneath and now the car will not move in any gear. It needs to be towed.', fault: 'IMMOBILISED_UNKNOWN', language: 'EN' },
  { id: 'im-5', text: 'Collision hui hai, bonnet uda hua hai aur radiator se paani beh raha hai. Gaadi bilkul nahi chal sakti.', fault: 'IMMOBILISED_UNKNOWN', language: 'MIX' },
  { id: 'im-6', text: 'The car is stuck in a flooded underpass and will not start or move. Water came up to the doors.', fault: 'IMMOBILISED_UNKNOWN', language: 'EN' },
  { id: 'im-7', text: 'Gearbox se zor ki awaaz aayi aur ab gaadi kisi bhi gear me nahi jaati, sadak ke beech khadi hai', fault: 'IMMOBILISED_UNKNOWN', language: 'HI' },
  { id: 'im-8', text: 'Something snapped underneath, there is oil all over the road and the wheels will not turn.', fault: 'IMMOBILISED_UNKNOWN', language: 'EN' },
  { id: 'im-9', text: 'Truck ne side maar di, gaadi damage ho gayi hai aur move nahi kar sakti. Main live lane me hoon, bahut khatra hai.', fault: 'IMMOBILISED_UNKNOWN', language: 'HI' },
];
