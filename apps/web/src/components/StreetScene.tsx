/**
 * The street.
 *
 * Doug's pixel-art scene from supermortgage.com, ported verbatim — the same
 * sprites, the same timings. It is the half of the brand the serif headline
 * cannot carry: the promise is a bank's front door, and this is the people it
 * is for. See docs/brand.md, "The pixel world".
 *
 * Every sprite is unit rectangles on an integer grid, authored at 4× and
 * scaled down by `zoom` in scene.css, which is why nothing here sets a size.
 * Decorative in full: the whole thing is aria-hidden, and it says nothing a
 * screen reader needs.
 *
 * The moving van is the one story beat. It drives in, parks for nine seconds,
 * and leaves — somebody moved house. Under prefers-reduced-motion every actor
 * is removed and the street stands still.
 *
 * GENERATED from the prototype's DOM. If Doug redraws the scene, re-port it
 * rather than hand-editing rectangles.
 */

export function StreetScene() {
  return (
    <div className="super-scene" aria-hidden="true">
      <div className="super-street-wrap">
        <div className="super-street">
          <svg width="232" height="176" viewBox="0 0 58 44">
            <rect x="17" y="0" width="4" height="2" fill="#FF3B30" />
            <rect x="13" y="2" width="12" height="2" fill="#FF3B30" />
            <rect x="9" y="4" width="20" height="2" fill="#FF3B30" />
            <rect x="5" y="6" width="28" height="2" fill="#FF3B30" />
            <rect x="1" y="8" width="36" height="2" fill="#FF3B30" />
            <rect x="3" y="10" width="32" height="26" fill="#ffb03a" />
            <rect x="6" y="14" width="6" height="6" fill="#7fe3ff" />
            <rect x="26" y="14" width="6" height="6" fill="#7fe3ff" />
            <rect x="8" y="14" width="2" height="6" fill="#ffb03a" />
            <rect x="28" y="14" width="2" height="6" fill="#ffb03a" />
            <rect x="3" y="24" width="32" height="2" fill="#c22f14" />
            <rect x="4" y="26" width="2" height="10" fill="#c22f14" />
            <rect x="32" y="26" width="2" height="10" fill="#c22f14" />
            <rect x="15" y="27" width="8" height="9" fill="#5b2d12" />
            <rect x="21" y="31" width="1" height="1" fill="#ffe08a" />
            <rect x="13" y="36" width="12" height="2" fill="#3a3a42" />
            <rect x="11" y="38" width="16" height="2" fill="#2c2c33" />
            <rect x="0" y="40" width="58" height="4" fill="#153a1c" />
            <rect x="27" y="1" width="4" height="6" fill="#c22f14" />
            <g className="yard-sign">
              <rect x="49" y="35" width="1" height="5" fill="#e8e2d6" />
              <rect x="40" y="26" width="19" height="9" fill="#fff3d6" />
              <rect x="40" y="34" width="19" height="1" fill="#d9cfae" />
              <rect x="42" y="28" width="3" height="1" fill="#FF3B30" />
              <rect x="42" y="29" width="1" height="1" fill="#FF3B30" />
              <rect x="42" y="30" width="3" height="1" fill="#FF3B30" />
              <rect x="44" y="31" width="1" height="1" fill="#FF3B30" />
              <rect x="42" y="32" width="3" height="1" fill="#FF3B30" />
              <rect x="46" y="28" width="3" height="1" fill="#FF3B30" />
              <rect x="46" y="29" width="1" height="1" fill="#FF3B30" />
              <rect x="48" y="29" width="1" height="1" fill="#FF3B30" />
              <rect x="46" y="30" width="1" height="1" fill="#FF3B30" />
              <rect x="48" y="30" width="1" height="1" fill="#FF3B30" />
              <rect x="46" y="31" width="1" height="1" fill="#FF3B30" />
              <rect x="48" y="31" width="1" height="1" fill="#FF3B30" />
              <rect x="46" y="32" width="3" height="1" fill="#FF3B30" />
              <rect x="50" y="28" width="1" height="1" fill="#FF3B30" />
              <rect x="50" y="29" width="1" height="1" fill="#FF3B30" />
              <rect x="50" y="30" width="1" height="1" fill="#FF3B30" />
              <rect x="50" y="31" width="1" height="1" fill="#FF3B30" />
              <rect x="50" y="32" width="3" height="1" fill="#FF3B30" />
              <rect x="54" y="28" width="2" height="1" fill="#FF3B30" />
              <rect x="54" y="29" width="1" height="1" fill="#FF3B30" />
              <rect x="56" y="29" width="1" height="1" fill="#FF3B30" />
              <rect x="54" y="30" width="1" height="1" fill="#FF3B30" />
              <rect x="56" y="30" width="1" height="1" fill="#FF3B30" />
              <rect x="54" y="31" width="1" height="1" fill="#FF3B30" />
              <rect x="56" y="31" width="1" height="1" fill="#FF3B30" />
              <rect x="54" y="32" width="2" height="1" fill="#FF3B30" />
            </g>
          </svg>
          <svg width="72" height="120" viewBox="0 0 18 30">
            <rect x="8" y="18" width="2" height="9" fill="#7a4a21" />
            <rect x="5" y="4" width="8" height="2" fill="#2fae4a" />
            <rect x="3" y="6" width="12" height="8" fill="#2fae4a" />
            <rect x="5" y="14" width="8" height="4" fill="#2fae4a" />
            <rect x="6" y="7" width="2" height="2" fill="#6fe08a" />
            <rect x="10" y="10" width="2" height="2" fill="#6fe08a" />
            <rect x="0" y="27" width="18" height="3" fill="#153a1c" />
          </svg>
          <svg width="176" height="220" viewBox="0 0 44 55">
            <rect x="31" y="0" width="2" height="2" fill="#12c2b0" />
            <rect x="29" y="2" width="6" height="2" fill="#12c2b0" />
            <rect x="27" y="4" width="10" height="3" fill="#0e8f83" />
            <rect x="28" y="7" width="8" height="18" fill="#12c2b0" />
            <rect x="30" y="10" width="4" height="5" fill="#2e2e44" />
            <rect x="12" y="9" width="4" height="2" fill="#0e8f83" />
            <rect x="8" y="11" width="12" height="2" fill="#0e8f83" />
            <rect x="4" y="13" width="20" height="2" fill="#0e8f83" />
            <rect x="1" y="15" width="26" height="2" fill="#0e8f83" />
            <rect x="3" y="17" width="25" height="30" fill="#12c2b0" />
            <rect x="6" y="21" width="5" height="7" fill="#2e2e44" />
            <rect x="16" y="21" width="5" height="7" fill="#2e2e44" />
            <rect x="8" y="21" width="1" height="7" fill="#0e8f83" />
            <rect x="18" y="21" width="1" height="7" fill="#0e8f83" />
            <rect x="30" y="30" width="4" height="6" fill="#2e2e44" />
            <rect x="11" y="37" width="7" height="10" fill="#a03cc9" />
            <rect x="16" y="41" width="1" height="1" fill="#ffe08a" />
            <rect x="3" y="33" width="25" height="1" fill="#7ff0e4" />
            <rect x="0" y="47" width="44" height="8" fill="#153a1c" />
            <rect x="36" y="42" width="8" height="1" fill="#e8e2d6" />
            <rect x="37" y="40" width="1" height="5" fill="#e8e2d6" />
            <rect x="40" y="40" width="1" height="5" fill="#e8e2d6" />
            <rect x="43" y="40" width="1" height="5" fill="#e8e2d6" />
          </svg>
          <svg width="144" height="184" viewBox="0 0 36 46">
            <rect x="20" y="2" width="14" height="36" fill="#2c2c33" />
            <rect x="22" y="4" width="10" height="32" fill="#7fe3ff" />
            <rect x="26" y="4" width="2" height="32" fill="#bdf1ff" />
            <rect x="2" y="14" width="18" height="24" fill="#ff8a3d" />
            <rect x="2" y="14" width="18" height="2" fill="#ffd9c0" />
            <rect x="2" y="20" width="18" height="1" fill="#c9611f" />
            <rect x="2" y="26" width="18" height="1" fill="#c9611f" />
            <rect x="2" y="32" width="18" height="1" fill="#c9611f" />
            <rect x="5" y="17" width="6" height="5" fill="#ffe08a" />
            <rect x="8" y="28" width="6" height="10" fill="#2c2c33" />
            <rect x="12" y="32" width="1" height="1" fill="#ffe08a" />
            <rect x="0" y="38" width="36" height="8" fill="#153a1c" />
          </svg>
          <svg width="56" height="92" viewBox="0 0 14 23">
            <rect x="6" y="13" width="2" height="7" fill="#7a4a21" />
            <rect x="3" y="3" width="8" height="2" fill="#2fae4a" />
            <rect x="2" y="5" width="10" height="6" fill="#2fae4a" />
            <rect x="4" y="11" width="6" height="2" fill="#2fae4a" />
            <rect x="8" y="6" width="2" height="2" fill="#6fe08a" />
            <rect x="0" y="20" width="14" height="3" fill="#153a1c" />
          </svg>
          <svg width="248" height="168" viewBox="0 0 62 42">
            <rect x="17" y="0" width="6" height="2" fill="#3a7bd5" />
            <rect x="12" y="2" width="16" height="2" fill="#3a7bd5" />
            <rect x="7" y="4" width="26" height="2" fill="#3a7bd5" />
            <rect x="2" y="6" width="36" height="2" fill="#3a7bd5" />
            <rect x="4" y="8" width="32" height="26" fill="#6aa8ff" />
            <rect x="8" y="13" width="6" height="7" fill="#2e2e44" />
            <rect x="26" y="13" width="6" height="7" fill="#ffe08a" />
            <rect x="10" y="13" width="2" height="7" fill="#3a7bd5" />
            <rect x="28" y="13" width="2" height="7" fill="#3a7bd5" />
            <rect x="16" y="24" width="8" height="10" fill="#e8e2d6" />
            <rect x="17" y="25" width="6" height="9" fill="#2c5eaa" />
            <rect x="21" y="29" width="1" height="1" fill="#ffe08a" />
            <rect x="29" y="0" width="4" height="6" fill="#c22f14" />
            <rect x="0" y="34" width="62" height="8" fill="#153a1c" />
            <g className="yard-sign">
              <rect x="51" y="29" width="1" height="5" fill="#e8e2d6" />
              <rect x="42" y="20" width="19" height="9" fill="#fff3d6" />
              <rect x="42" y="28" width="19" height="1" fill="#d9cfae" />
              <rect x="44" y="22" width="3" height="1" fill="#FF3B30" />
              <rect x="44" y="23" width="1" height="1" fill="#FF3B30" />
              <rect x="44" y="24" width="3" height="1" fill="#FF3B30" />
              <rect x="46" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="44" y="26" width="3" height="1" fill="#FF3B30" />
              <rect x="48" y="22" width="3" height="1" fill="#FF3B30" />
              <rect x="48" y="23" width="1" height="1" fill="#FF3B30" />
              <rect x="50" y="23" width="1" height="1" fill="#FF3B30" />
              <rect x="48" y="24" width="1" height="1" fill="#FF3B30" />
              <rect x="50" y="24" width="1" height="1" fill="#FF3B30" />
              <rect x="48" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="50" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="48" y="26" width="3" height="1" fill="#FF3B30" />
              <rect x="52" y="22" width="1" height="1" fill="#FF3B30" />
              <rect x="52" y="23" width="1" height="1" fill="#FF3B30" />
              <rect x="52" y="24" width="1" height="1" fill="#FF3B30" />
              <rect x="52" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="52" y="26" width="3" height="1" fill="#FF3B30" />
              <rect x="56" y="22" width="2" height="1" fill="#FF3B30" />
              <rect x="56" y="23" width="1" height="1" fill="#FF3B30" />
              <rect x="58" y="23" width="1" height="1" fill="#FF3B30" />
              <rect x="56" y="24" width="1" height="1" fill="#FF3B30" />
              <rect x="58" y="24" width="1" height="1" fill="#FF3B30" />
              <rect x="56" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="58" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="56" y="26" width="2" height="1" fill="#FF3B30" />
            </g>
          </svg>
          <svg width="232" height="228" viewBox="0 0 58 57">
            <rect x="6" y="0" width="26" height="2" fill="#5b3aa8" />
            <rect x="4" y="2" width="30" height="8" fill="#7b52d6" />
            <rect x="9" y="3" width="5" height="6" fill="#b79bff" />
            <rect x="10" y="4" width="3" height="4" fill="#2e2e44" />
            <rect x="24" y="3" width="5" height="6" fill="#b79bff" />
            <rect x="25" y="4" width="3" height="4" fill="#ffe08a" />
            <rect x="4" y="10" width="30" height="39" fill="#a17ff0" />
            <rect x="4" y="10" width="30" height="1" fill="#d8c8ff" />
            <rect x="8" y="14" width="6" height="7" fill="#2e2e44" />
            <rect x="24" y="14" width="6" height="7" fill="#2e2e44" />
            <rect x="8" y="26" width="6" height="7" fill="#ffe08a" />
            <rect x="24" y="26" width="6" height="7" fill="#2e2e44" />
            <rect x="23" y="33" width="8" height="1" fill="#d8c8ff" />
            <rect x="15" y="39" width="8" height="10" fill="#2c2c33" />
            <rect x="21" y="43" width="1" height="1" fill="#ffe08a" />
            <rect x="0" y="49" width="58" height="8" fill="#153a1c" />
            <g className="yard-sign">
              <rect x="49" y="45" width="1" height="4" fill="#e8e2d6" />
              <rect x="40" y="36" width="19" height="9" fill="#fff3d6" />
              <rect x="40" y="44" width="19" height="1" fill="#d9cfae" />
              <rect x="42" y="38" width="2" height="1" fill="#12c2b0" />
              <rect x="42" y="39" width="1" height="1" fill="#12c2b0" />
              <rect x="44" y="39" width="1" height="1" fill="#12c2b0" />
              <rect x="42" y="40" width="2" height="1" fill="#12c2b0" />
              <rect x="42" y="41" width="1" height="1" fill="#12c2b0" />
              <rect x="44" y="41" width="1" height="1" fill="#12c2b0" />
              <rect x="42" y="42" width="1" height="1" fill="#12c2b0" />
              <rect x="44" y="42" width="1" height="1" fill="#12c2b0" />
              <rect x="46" y="38" width="3" height="1" fill="#12c2b0" />
              <rect x="46" y="39" width="1" height="1" fill="#12c2b0" />
              <rect x="46" y="40" width="2" height="1" fill="#12c2b0" />
              <rect x="46" y="41" width="1" height="1" fill="#12c2b0" />
              <rect x="46" y="42" width="3" height="1" fill="#12c2b0" />
              <rect x="50" y="38" width="3" height="1" fill="#12c2b0" />
              <rect x="50" y="39" width="1" height="1" fill="#12c2b0" />
              <rect x="50" y="40" width="2" height="1" fill="#12c2b0" />
              <rect x="50" y="41" width="1" height="1" fill="#12c2b0" />
              <rect x="50" y="42" width="1" height="1" fill="#12c2b0" />
              <rect x="54" y="38" width="3" height="1" fill="#12c2b0" />
              <rect x="55" y="39" width="1" height="1" fill="#12c2b0" />
              <rect x="55" y="40" width="1" height="1" fill="#12c2b0" />
              <rect x="55" y="41" width="1" height="1" fill="#12c2b0" />
              <rect x="54" y="42" width="3" height="1" fill="#12c2b0" />
            </g>
            <g className="super-rate-pulse">
              <rect x="44" y="28" width="1" height="1" fill="#2fae4a" />
              <rect x="46" y="28" width="1" height="1" fill="#2fae4a" />
              <rect x="46" y="29" width="1" height="1" fill="#2fae4a" />
              <rect x="45" y="30" width="1" height="1" fill="#2fae4a" />
              <rect x="44" y="31" width="1" height="1" fill="#2fae4a" />
              <rect x="44" y="32" width="1" height="1" fill="#2fae4a" />
              <rect x="46" y="32" width="1" height="1" fill="#2fae4a" />
              <rect x="50" y="30" width="3" height="1" fill="#2fae4a" />
              <rect x="51" y="31" width="1" height="1" fill="#2fae4a" />
            </g>
          </svg>
          <svg width="72" height="120" viewBox="0 0 18 30">
            <rect x="8" y="18" width="2" height="9" fill="#7a4a21" />
            <rect x="5" y="4" width="8" height="2" fill="#2fae4a" />
            <rect x="3" y="6" width="12" height="8" fill="#2fae4a" />
            <rect x="5" y="14" width="8" height="4" fill="#2fae4a" />
            <rect x="6" y="7" width="2" height="2" fill="#6fe08a" />
            <rect x="10" y="10" width="2" height="2" fill="#6fe08a" />
            <rect x="0" y="27" width="18" height="3" fill="#153a1c" />
          </svg>
          <svg width="168" height="192" viewBox="0 0 42 48">
            <rect x="19" y="0" width="4" height="2" fill="#2fae4a" />
            <rect x="15" y="2" width="12" height="2" fill="#2fae4a" />
            <rect x="11" y="4" width="20" height="2" fill="#2fae4a" />
            <rect x="7" y="6" width="28" height="2" fill="#2fae4a" />
            <rect x="3" y="8" width="36" height="2" fill="#2fae4a" />
            <rect x="5" y="10" width="32" height="4" fill="#2fae4a" />
            <rect x="5" y="14" width="32" height="24" fill="#8ee6a3" />
            <rect x="5" y="18" width="32" height="1" fill="#5fc77b" />
            <rect x="5" y="23" width="32" height="1" fill="#5fc77b" />
            <rect x="19" y="10" width="4" height="3" fill="#ffe08a" />
            <rect x="8" y="26" width="6" height="6" fill="#2e2e44" />
            <rect x="28" y="26" width="6" height="6" fill="#2e2e44" />
            <rect x="5" y="24" width="32" height="1" fill="#1d7c33" />
            <rect x="6" y="25" width="1" height="13" fill="#1d7c33" />
            <rect x="35" y="25" width="1" height="13" fill="#1d7c33" />
            <rect x="17" y="27" width="8" height="11" fill="#5b2d12" />
            <rect x="23" y="32" width="1" height="1" fill="#ffe08a" />
            <rect x="0" y="38" width="42" height="10" fill="#153a1c" />
            <rect x="10" y="34" width="3" height="2" fill="#ff3b30" />
            <rect x="11" y="32" width="1" height="2" fill="#2fae4a" />
          </svg>
          <svg width="232" height="200" viewBox="0 0 58 50">
            <rect x="30" y="2" width="2" height="2" fill="#ff8a3d" />
            <rect x="29" y="3" width="4" height="2" fill="#ff8a3d" />
            <rect x="30" y="5" width="2" height="1" fill="#ff8a3d" />
            <rect x="31" y="6" width="1" height="4" fill="#e8e2d6" />
            <rect x="17" y="8" width="4" height="2" fill="#2a6fd6" />
            <rect x="14" y="10" width="10" height="2" fill="#2a6fd6" />
            <rect x="11" y="12" width="16" height="2" fill="#2a6fd6" />
            <rect x="8" y="14" width="22" height="2" fill="#2a6fd6" />
            <rect x="5" y="16" width="28" height="2" fill="#2a6fd6" />
            <rect x="2" y="18" width="34" height="2" fill="#2a6fd6" />
            <rect x="4" y="20" width="30" height="22" fill="#7fb8ff" />
            <rect x="17" y="12" width="4" height="1" fill="#ffe08a" />
            <rect x="16" y="13" width="6" height="3" fill="#ffe08a" />
            <rect x="17" y="16" width="4" height="1" fill="#ffe08a" />
            <rect x="15" y="30" width="8" height="12" fill="#ff8a3d" />
            <rect x="21" y="35" width="1" height="1" fill="#5b2d12" />
            <rect x="7" y="26" width="5" height="8" fill="#ffe08a" />
            <rect x="26" y="26" width="5" height="8" fill="#2e2e44" />
            <rect x="0" y="42" width="58" height="8" fill="#153a1c" />
            <g className="yard-sign">
              <rect x="49" y="37" width="1" height="5" fill="#e8e2d6" />
              <rect x="40" y="28" width="19" height="9" fill="#fff3d6" />
              <rect x="40" y="36" width="19" height="1" fill="#d9cfae" />
              <rect x="42" y="30" width="2" height="1" fill="#12c2b0" />
              <rect x="42" y="31" width="1" height="1" fill="#12c2b0" />
              <rect x="44" y="31" width="1" height="1" fill="#12c2b0" />
              <rect x="42" y="32" width="2" height="1" fill="#12c2b0" />
              <rect x="42" y="33" width="1" height="1" fill="#12c2b0" />
              <rect x="44" y="33" width="1" height="1" fill="#12c2b0" />
              <rect x="42" y="34" width="1" height="1" fill="#12c2b0" />
              <rect x="44" y="34" width="1" height="1" fill="#12c2b0" />
              <rect x="46" y="30" width="3" height="1" fill="#12c2b0" />
              <rect x="46" y="31" width="1" height="1" fill="#12c2b0" />
              <rect x="46" y="32" width="2" height="1" fill="#12c2b0" />
              <rect x="46" y="33" width="1" height="1" fill="#12c2b0" />
              <rect x="46" y="34" width="3" height="1" fill="#12c2b0" />
              <rect x="50" y="30" width="3" height="1" fill="#12c2b0" />
              <rect x="50" y="31" width="1" height="1" fill="#12c2b0" />
              <rect x="50" y="32" width="2" height="1" fill="#12c2b0" />
              <rect x="50" y="33" width="1" height="1" fill="#12c2b0" />
              <rect x="50" y="34" width="1" height="1" fill="#12c2b0" />
              <rect x="54" y="30" width="3" height="1" fill="#12c2b0" />
              <rect x="55" y="31" width="1" height="1" fill="#12c2b0" />
              <rect x="55" y="32" width="1" height="1" fill="#12c2b0" />
              <rect x="55" y="33" width="1" height="1" fill="#12c2b0" />
              <rect x="54" y="34" width="3" height="1" fill="#12c2b0" />
            </g>
            <g className="super-rate-pulse">
              <rect x="44" y="20" width="1" height="1" fill="#2fae4a" />
              <rect x="46" y="20" width="1" height="1" fill="#2fae4a" />
              <rect x="46" y="21" width="1" height="1" fill="#2fae4a" />
              <rect x="45" y="22" width="1" height="1" fill="#2fae4a" />
              <rect x="44" y="23" width="1" height="1" fill="#2fae4a" />
              <rect x="44" y="24" width="1" height="1" fill="#2fae4a" />
              <rect x="46" y="24" width="1" height="1" fill="#2fae4a" />
              <rect x="50" y="22" width="3" height="1" fill="#2fae4a" />
              <rect x="51" y="23" width="1" height="1" fill="#2fae4a" />
            </g>
          </svg>
          <svg width="256" height="176" viewBox="0 0 64 44">
            <rect x="18" y="0" width="4" height="2" fill="#e0a41f" />
            <rect x="14" y="2" width="12" height="2" fill="#e0a41f" />
            <rect x="9" y="4" width="22" height="2" fill="#e0a41f" />
            <rect x="4" y="6" width="32" height="2" fill="#e0a41f" />
            <rect x="6" y="8" width="28" height="28" fill="#ffd23a" />
            <rect x="18" y="10" width="4" height="4" fill="#7a4a21" />
            <rect x="19" y="11" width="2" height="2" fill="#ffe08a" />
            <rect x="9" y="18" width="6" height="8" fill="#ffe08a" />
            <rect x="25" y="18" width="6" height="8" fill="#2e2e44" />
            <rect x="11" y="18" width="2" height="8" fill="#e0a41f" />
            <rect x="27" y="18" width="2" height="8" fill="#e0a41f" />
            <rect x="16" y="26" width="8" height="10" fill="#ff3b30" />
            <rect x="22" y="30" width="1" height="1" fill="#ffe08a" />
            <rect x="0" y="36" width="64" height="8" fill="#153a1c" />
            <rect x="36" y="28" width="4" height="3" fill="#3a3a42" />
            <rect x="37" y="31" width="1" height="5" fill="#7a4a21" />
            <g className="yard-sign">
              <rect x="53" y="31" width="1" height="5" fill="#e8e2d6" />
              <rect x="44" y="22" width="19" height="9" fill="#fff3d6" />
              <rect x="44" y="30" width="19" height="1" fill="#d9cfae" />
              <rect x="46" y="24" width="3" height="1" fill="#FF3B30" />
              <rect x="46" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="46" y="26" width="3" height="1" fill="#FF3B30" />
              <rect x="48" y="27" width="1" height="1" fill="#FF3B30" />
              <rect x="46" y="28" width="3" height="1" fill="#FF3B30" />
              <rect x="50" y="24" width="3" height="1" fill="#FF3B30" />
              <rect x="50" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="52" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="50" y="26" width="1" height="1" fill="#FF3B30" />
              <rect x="52" y="26" width="1" height="1" fill="#FF3B30" />
              <rect x="50" y="27" width="1" height="1" fill="#FF3B30" />
              <rect x="52" y="27" width="1" height="1" fill="#FF3B30" />
              <rect x="50" y="28" width="3" height="1" fill="#FF3B30" />
              <rect x="54" y="24" width="1" height="1" fill="#FF3B30" />
              <rect x="54" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="54" y="26" width="1" height="1" fill="#FF3B30" />
              <rect x="54" y="27" width="1" height="1" fill="#FF3B30" />
              <rect x="54" y="28" width="3" height="1" fill="#FF3B30" />
              <rect x="58" y="24" width="2" height="1" fill="#FF3B30" />
              <rect x="58" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="60" y="25" width="1" height="1" fill="#FF3B30" />
              <rect x="58" y="26" width="1" height="1" fill="#FF3B30" />
              <rect x="60" y="26" width="1" height="1" fill="#FF3B30" />
              <rect x="58" y="27" width="1" height="1" fill="#FF3B30" />
              <rect x="60" y="27" width="1" height="1" fill="#FF3B30" />
              <rect x="58" y="28" width="2" height="1" fill="#FF3B30" />
            </g>
          </svg>
          <svg width="56" height="92" viewBox="0 0 14 23">
            <rect x="6" y="13" width="2" height="7" fill="#7a4a21" />
            <rect x="3" y="3" width="8" height="2" fill="#2fae4a" />
            <rect x="2" y="5" width="10" height="6" fill="#2fae4a" />
            <rect x="4" y="11" width="6" height="2" fill="#2fae4a" />
            <rect x="8" y="6" width="2" height="2" fill="#6fe08a" />
            <rect x="0" y="20" width="14" height="3" fill="#153a1c" />
          </svg>
          <svg width="152" height="176" viewBox="0 0 38 44">
            <rect x="14" y="4" width="22" height="34" fill="#c98a4b" />
            <rect x="14" y="4" width="22" height="2" fill="#f0c795" />
            <rect x="17" y="8" width="10" height="4" fill="#2e2e44" />
            <rect x="18" y="20" width="12" height="6" fill="#ffe08a" />
            <rect x="2" y="16" width="12" height="22" fill="#8a5a30" />
            <rect x="1" y="20" width="14" height="2" fill="#3a3a42" />
            <rect x="4" y="24" width="6" height="14" fill="#2c2c33" />
            <rect x="8" y="30" width="1" height="1" fill="#ffe08a" />
            <rect x="0" y="38" width="38" height="6" fill="#153a1c" />
            <rect x="30" y="33" width="2" height="1" fill="#12c2b0" />
            <rect x="29" y="34" width="1" height="3" fill="#12c2b0" />
            <rect x="33" y="34" width="1" height="3" fill="#12c2b0" />
            <rect x="28" y="36" width="3" height="1" fill="#7fe3ff" />
            <rect x="32" y="36" width="3" height="1" fill="#7fe3ff" />
          </svg>
          <svg width="144" height="208" viewBox="0 0 36 52">
            <rect x="16" y="0" width="4" height="2" fill="#c22f14" />
            <rect x="11" y="2" width="14" height="2" fill="#c22f14" />
            <rect x="6" y="4" width="24" height="2" fill="#c22f14" />
            <rect x="4" y="6" width="28" height="40" fill="#ff6a4d" />
            <rect x="4" y="12" width="28" height="1" fill="#d64a2e" />
            <rect x="4" y="22" width="28" height="1" fill="#d64a2e" />
            <rect x="4" y="32" width="28" height="1" fill="#d64a2e" />
            <rect x="16" y="8" width="4" height="1" fill="#ffe08a" />
            <rect x="15" y="9" width="6" height="2" fill="#ffe08a" />
            <rect x="16" y="11" width="4" height="1" fill="#ffe08a" />
            <rect x="7" y="15" width="6" height="7" fill="#2e2e44" />
            <rect x="23" y="15" width="6" height="7" fill="#2e2e44" />
            <rect x="7" y="26" width="6" height="7" fill="#ffe08a" />
            <rect x="23" y="26" width="6" height="7" fill="#2e2e44" />
            <rect x="14" y="36" width="8" height="10" fill="#2c2c33" />
            <rect x="20" y="40" width="1" height="1" fill="#ffe08a" />
            <rect x="0" y="46" width="36" height="6" fill="#153a1c" />
          </svg>
          <svg width="224" height="160" viewBox="0 0 56 40">
            <rect x="15" y="0" width="4" height="2" fill="#c94f3d" />
            <rect x="11" y="2" width="12" height="2" fill="#c94f3d" />
            <rect x="6" y="4" width="22" height="2" fill="#c94f3d" />
            <rect x="2" y="6" width="30" height="2" fill="#c94f3d" />
            <rect x="4" y="8" width="26" height="24" fill="#fff3d6" />
            <rect x="14" y="20" width="6" height="1" fill="#7a4a21" />
            <rect x="13" y="21" width="8" height="11" fill="#7a4a21" />
            <rect x="19" y="26" width="1" height="1" fill="#ffe08a" />
            <rect x="6" y="13" width="5" height="6" fill="#ffe08a" />
            <rect x="23" y="13" width="5" height="6" fill="#2e2e44" />
            <rect x="5" y="19" width="7" height="1" fill="#ff3b30" />
            <rect x="22" y="19" width="7" height="1" fill="#ff3b30" />
            <rect x="0" y="32" width="56" height="8" fill="#153a1c" />
            <g className="yard-sign">
              <rect x="45" y="27" width="1" height="5" fill="#e8e2d6" />
              <rect x="36" y="18" width="19" height="9" fill="#fff3d6" />
              <rect x="36" y="26" width="19" height="1" fill="#d9cfae" />
              <rect x="38" y="20" width="2" height="1" fill="#12c2b0" />
              <rect x="38" y="21" width="1" height="1" fill="#12c2b0" />
              <rect x="40" y="21" width="1" height="1" fill="#12c2b0" />
              <rect x="38" y="22" width="2" height="1" fill="#12c2b0" />
              <rect x="38" y="23" width="1" height="1" fill="#12c2b0" />
              <rect x="40" y="23" width="1" height="1" fill="#12c2b0" />
              <rect x="38" y="24" width="1" height="1" fill="#12c2b0" />
              <rect x="40" y="24" width="1" height="1" fill="#12c2b0" />
              <rect x="42" y="20" width="3" height="1" fill="#12c2b0" />
              <rect x="42" y="21" width="1" height="1" fill="#12c2b0" />
              <rect x="42" y="22" width="2" height="1" fill="#12c2b0" />
              <rect x="42" y="23" width="1" height="1" fill="#12c2b0" />
              <rect x="42" y="24" width="3" height="1" fill="#12c2b0" />
              <rect x="46" y="20" width="3" height="1" fill="#12c2b0" />
              <rect x="46" y="21" width="1" height="1" fill="#12c2b0" />
              <rect x="46" y="22" width="2" height="1" fill="#12c2b0" />
              <rect x="46" y="23" width="1" height="1" fill="#12c2b0" />
              <rect x="46" y="24" width="1" height="1" fill="#12c2b0" />
              <rect x="50" y="20" width="3" height="1" fill="#12c2b0" />
              <rect x="51" y="21" width="1" height="1" fill="#12c2b0" />
              <rect x="51" y="22" width="1" height="1" fill="#12c2b0" />
              <rect x="51" y="23" width="1" height="1" fill="#12c2b0" />
              <rect x="50" y="24" width="3" height="1" fill="#12c2b0" />
            </g>
            <g className="super-rate-pulse">
              <rect x="40" y="10" width="1" height="1" fill="#2fae4a" />
              <rect x="42" y="10" width="1" height="1" fill="#2fae4a" />
              <rect x="42" y="11" width="1" height="1" fill="#2fae4a" />
              <rect x="41" y="12" width="1" height="1" fill="#2fae4a" />
              <rect x="40" y="13" width="1" height="1" fill="#2fae4a" />
              <rect x="40" y="14" width="1" height="1" fill="#2fae4a" />
              <rect x="42" y="14" width="1" height="1" fill="#2fae4a" />
              <rect x="46" y="12" width="3" height="1" fill="#2fae4a" />
              <rect x="47" y="13" width="1" height="1" fill="#2fae4a" />
            </g>
          </svg>
        </div>
      </div>
      <div className="super-ground-base" />
      <div className="super-actor super-walk super-walker1">
        <svg width="26" height="55" viewBox="0 0 10 21">
          <rect x="3" y="0" width="4" height="1" fill="#2c2c33" />
          <rect x="3" y="1" width="4" height="3" fill="#ffcf9f" />
          <rect x="2" y="4" width="6" height="7" fill="#ff3b30" />
          <rect x="1" y="5" width="1" height="4" fill="#ff3b30" />
          <rect x="8" y="5" width="1" height="4" fill="#ff3b30" />
          <g className="super-fA">
            <rect x="2" y="11" width="2" height="8" fill="#2a6fd6" />
            <rect x="6" y="11" width="2" height="8" fill="#2a6fd6" />
            <rect x="1" y="19" width="3" height="2" fill="#2c2c33" />
            <rect x="6" y="19" width="3" height="2" fill="#2c2c33" />
          </g>
          <g className="super-fB">
            <rect x="3" y="11" width="2" height="8" fill="#2a6fd6" />
            <rect x="5" y="11" width="2" height="8" fill="#2a6fd6" />
            <rect x="3" y="19" width="2" height="2" fill="#2c2c33" />
            <rect x="5" y="19" width="2" height="2" fill="#2c2c33" />
          </g>
        </svg>
      </div>
      <div className="super-actor super-walk super-walker2">
        <svg width="68" height="55" viewBox="0 0 26 21">
          <rect x="3" y="0" width="4" height="1" fill="#7a4a21" />
          <rect x="3" y="1" width="4" height="3" fill="#ffcf9f" />
          <rect x="2" y="4" width="6" height="7" fill="#ffd23a" />
          <rect x="1" y="5" width="1" height="4" fill="#ffd23a" />
          <rect x="8" y="5" width="1" height="4" fill="#ffd23a" />
          <g className="super-fA">
            <rect x="2" y="11" width="2" height="8" fill="#2c2c33" />
            <rect x="6" y="11" width="2" height="8" fill="#2c2c33" />
            <rect x="1" y="19" width="3" height="2" fill="#5b2d12" />
            <rect x="6" y="19" width="3" height="2" fill="#5b2d12" />
          </g>
          <g className="super-fB">
            <rect x="3" y="11" width="2" height="8" fill="#2c2c33" />
            <rect x="5" y="11" width="2" height="8" fill="#2c2c33" />
            <rect x="3" y="19" width="2" height="2" fill="#5b2d12" />
            <rect x="5" y="19" width="2" height="2" fill="#5b2d12" />
          </g>
          <rect x="10" y="10" width="2" height="1" fill="#e8e2d6" />
          <rect x="12" y="11" width="2" height="1" fill="#e8e2d6" />
          <rect x="14" y="12" width="2" height="1" fill="#e8e2d6" />
          <rect x="16" y="13" width="5" height="1" fill="#e8e2d6" />
          <rect x="16" y="15" width="7" height="3" fill="#c98a4b" />
          <rect x="22" y="13" width="3" height="3" fill="#c98a4b" />
          <rect x="22" y="12" width="1" height="1" fill="#8a5a30" />
          <rect x="15" y="14" width="1" height="2" fill="#c98a4b" />
          <g className="super-fA">
            <rect x="17" y="18" width="1" height="3" fill="#c98a4b" />
            <rect x="21" y="18" width="1" height="3" fill="#c98a4b" />
          </g>
          <g className="super-fB">
            <rect x="18" y="18" width="1" height="3" fill="#c98a4b" />
            <rect x="20" y="18" width="1" height="3" fill="#c98a4b" />
          </g>
        </svg>
      </div>
      <div className="super-actor super-walk super-jogger">
        <svg width="26" height="55" viewBox="0 0 10 21">
          <rect x="3" y="0" width="4" height="1" fill="#e8e2d6" />
          <rect x="3" y="1" width="4" height="3" fill="#b07047" />
          <rect x="2" y="4" width="6" height="7" fill="#12c2b0" />
          <rect x="1" y="5" width="1" height="4" fill="#12c2b0" />
          <rect x="8" y="5" width="1" height="4" fill="#12c2b0" />
          <g className="super-fA">
            <rect x="2" y="11" width="2" height="8" fill="#3a3a42" />
            <rect x="6" y="11" width="2" height="8" fill="#3a3a42" />
            <rect x="1" y="19" width="3" height="2" fill="#ff3b30" />
            <rect x="6" y="19" width="3" height="2" fill="#ff3b30" />
          </g>
          <g className="super-fB">
            <rect x="3" y="11" width="2" height="8" fill="#3a3a42" />
            <rect x="5" y="11" width="2" height="8" fill="#3a3a42" />
            <rect x="3" y="19" width="2" height="2" fill="#ff3b30" />
            <rect x="5" y="19" width="2" height="2" fill="#ff3b30" />
          </g>
        </svg>
      </div>
      <div className="super-actor super-drive super-car1">
        <svg width="102" height="42" viewBox="0 0 34 14">
          <rect x="8" y="1" width="15" height="4" fill="#ff3b30" />
          <rect x="10" y="2" width="5" height="3" fill="#bdf1ff" />
          <rect x="16" y="2" width="6" height="3" fill="#bdf1ff" />
          <rect x="1" y="5" width="32" height="5" fill="#ff3b30" />
          <rect x="32" y="6" width="2" height="2" fill="#ffe08a" />
          <rect x="0" y="6" width="1" height="2" fill="#ff8a8a" />
          <rect x="5" y="9" width="5" height="5" fill="#17171c" />
          <rect x="24" y="9" width="5" height="5" fill="#17171c" />
          <g className="super-hubA">
            <rect x="7" y="11" width="1" height="1" fill="#8a8a92" />
            <rect x="26" y="11" width="1" height="1" fill="#8a8a92" />
          </g>
          <g className="super-hubB">
            <rect x="6" y="10" width="1" height="1" fill="#8a8a92" />
            <rect x="25" y="10" width="1" height="1" fill="#8a8a92" />
          </g>
        </svg>
      </div>
      <div className="super-actor super-drive super-car2">
        <svg width="102" height="42" viewBox="0 0 34 14">
          <rect x="8" y="1" width="15" height="4" fill="#12c2b0" />
          <rect x="10" y="2" width="5" height="3" fill="#bdf1ff" />
          <rect x="16" y="2" width="6" height="3" fill="#bdf1ff" />
          <rect x="1" y="5" width="32" height="5" fill="#12c2b0" />
          <rect x="32" y="6" width="2" height="2" fill="#ffe08a" />
          <rect x="0" y="6" width="1" height="2" fill="#ff8a8a" />
          <rect x="5" y="9" width="5" height="5" fill="#17171c" />
          <rect x="24" y="9" width="5" height="5" fill="#17171c" />
          <g className="super-hubA">
            <rect x="7" y="11" width="1" height="1" fill="#8a8a92" />
            <rect x="26" y="11" width="1" height="1" fill="#8a8a92" />
          </g>
          <g className="super-hubB">
            <rect x="6" y="10" width="1" height="1" fill="#8a8a92" />
            <rect x="25" y="10" width="1" height="1" fill="#8a8a92" />
          </g>
        </svg>
      </div>
      <div className="super-actor super-drive super-van">
        <svg width="132" height="54" viewBox="0 0 44 18">
          <rect x="0" y="0" width="30" height="13" fill="#e8e2d6" />
          <rect x="0" y="11" width="30" height="2" fill="#c9c2b4" />
          <rect x="12" y="3" width="2" height="1" fill="#FF3B30" />
          <rect x="11" y="4" width="4" height="1" fill="#FF3B30" />
          <rect x="10" y="5" width="6" height="1" fill="#FF3B30" />
          <rect x="11" y="6" width="4" height="3" fill="#FF3B30" />
          <rect x="12" y="7" width="2" height="2" fill="#e8e2d6" />
          <rect x="30" y="5" width="12" height="8" fill="#FF3B30" />
          <rect x="36" y="6" width="4" height="4" fill="#bdf1ff" />
          <rect x="42" y="9" width="2" height="2" fill="#ffe08a" />
          <rect x="4" y="13" width="5" height="5" fill="#17171c" />
          <rect x="33" y="13" width="5" height="5" fill="#17171c" />
          <rect x="6" y="15" width="1" height="1" fill="#8a8a92" />
          <rect x="35" y="15" width="1" height="1" fill="#8a8a92" />
        </svg>
      </div>
    </div>
  );
}
