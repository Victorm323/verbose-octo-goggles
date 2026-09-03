"""Interactive console for reconstructing a real Dominican game.

Run ``python -m dominord`` and type what happens at the table:

    mano 6-6 5-5 3-1 0-0 2-6 4-4 5-0     # your seven tiles
    juan 6-6                             # somebody plays
    paso socio
    eval                                 # the full read of the position

Every command has a Spanish and an English name; players can be named by seat
number or by (a prefix of) their name.
"""

from __future__ import annotations

import argparse
import random
import sys
from dataclasses import dataclass
from typing import Optional, Sequence

from .evaluation import evaluate_position
from .inference import InconsistentObservations, build_beliefs
from .render import (render_bar, render_beliefs, render_chain, render_match,
                     render_moves, render_position, render_seats, rule)
from .rules import PRESETS, preset
from .search import DEEP, DEFAULT, FAST, LIVE, SearchConfig
from .selfplay import engine_chooser, greedy_chooser, play_match
from .session import Session, SessionError
from .state import End, IllegalMove
from .table import TableView
from .tiles import Tile, parse_tiles

BANNER = """dominord - motor de dominó dominicano
escribe 'ayuda' para ver los comandos, 'salir' para terminar"""

HELP = """
comandos (los nombres en inglés también funcionan)

  nueva [patio|patio100|formal]   empezar una partida nueva
  nombres <a> <b> <c> <d>         nombrar a los cuatro jugadores
  soy <jugador>                   decir en qué asiento estás
  salida <jugador>                quién sale en esta mano
  mano <7 fichas>                 tus fichas, y empieza la mano
  juega <jugador> <ficha> [izq|der]   registrar una jugada
     (atajo: "<jugador> <ficha> [izq|der]")
  paso <jugador>                  registrar un paso
  deshacer                        borrar la última jugada
  mesa                            ver la mesa y los asientos
  eval [rápido|hondo]             análisis completo de la posición
  barra                           solo la barra de ventaja
  fichas [n]                      probabilidades de quién tiene qué
  sugerencia [jugador]            mejores jugadas de un jugador
  fin puntos <p0> <p1> <p2> <p3>  cerrar la mano con los puntos que quedaron
  fin fichas <jugador>=<fichas> ... cerrar la mano con las fichas reveladas
  puntos                          marcador de la partida
  guardar <archivo> / cargar <archivo>
  salir
"""


@dataclass
class Console:
    session: Session
    config: SearchConfig = DEFAULT
    auto: bool = True
    out = sys.stdout

    # ------------------------------------------------------------------
    def write(self, text: str = "") -> None:
        print(text, file=self.out)

    def seat(self, token: str) -> int:
        """Resolve ``0``/``P2``/``jua`` to a seat number."""
        token = token.strip().lower()
        if token.isdigit():
            seat = int(token)
        elif token.startswith("p") and token[1:].isdigit():
            seat = int(token[1:])
        else:
            hits = [i for i, name in enumerate(self.session.player_names)
                    if name.lower().startswith(token)]
            if len(hits) != 1:
                raise SessionError(f"no sé quién es {token!r}")
            seat = hits[0]
        if not 0 <= seat < self.session.rules.players:
            raise SessionError(f"asiento fuera de rango: {seat}")
        return seat

    @staticmethod
    def end(token: Optional[str]) -> Optional[End]:
        if token is None:
            return None
        token = token.lower()
        if token in ("izq", "izquierda", "l", "left", "i"):
            return End.LEFT
        if token in ("der", "derecha", "r", "right", "d"):
            return End.RIGHT
        raise SessionError(f"¿izquierda o derecha? no entiendo {token!r}")

    # ------------------------------------------------------------------
    def run(self, line: str) -> None:
        parts = line.split()
        if not parts:
            return
        head, args = parts[0].lower(), parts[1:]
        handler = COMMANDS.get(head)
        if handler is not None:
            handler(self, args)
            return
        # Shorthand: "<jugador> <ficha> [izq|der]"
        try:
            self.seat(head)          # does the first word name a player?
        except SessionError:
            raise SessionError(f"comando desconocido: {head!r} (prueba 'ayuda')")
        if not args:
            raise SessionError("¿qué jugó? escribe la ficha, p.ej. 'juan 6-4'")
        self.cmd_play([head] + args)

    # ---------------------------------------------------------------- setup
    def cmd_help(self, args: Sequence[str]) -> None:
        self.write(HELP)

    def cmd_new(self, args: Sequence[str]) -> None:
        name = args[0] if args else "patio"
        rules = preset(name)
        self.session = Session(
            rules=rules,
            player_names=self.session.player_names,
            hero=self.session.hero,
            team_names=self.session.team_names,
        )
        self.write(f"partida nueva ({name}, a {rules.target_score} puntos)")

    def cmd_names(self, args: Sequence[str]) -> None:
        if len(args) != self.session.rules.players:
            raise SessionError(
                f"dame {self.session.rules.players} nombres en orden de turno")
        self.session.player_names = tuple(args)
        if self.session.view is not None:
            self.session.view.player_names = tuple(args)
        self.write("jugadores: " + ", ".join(
            f"{i}:{n}" for i, n in enumerate(args)))

    def cmd_hero(self, args: Sequence[str]) -> None:
        if not args:
            raise SessionError("¿en qué asiento estás?")
        self.session.hero = self.seat(args[0])
        self.write(f"tú eres {self.session.player_names[self.session.hero]}")

    def cmd_open(self, args: Sequence[str]) -> None:
        if not args:
            raise SessionError("¿quién sale?")
        seat = self.seat(args[0])
        if self.session.view is not None and not self.session.view.moves:
            self.session.view.opener = seat
            self.session.view._derived = None
        else:
            self.session.match.next_opener = seat
        self.write(f"sale {self.session.player_names[seat]}")

    def cmd_deal(self, args: Sequence[str]) -> None:
        tiles = parse_tiles(" ".join(args))
        opener = None
        if self.session.view is not None and not self.session.view.moves:
            opener = self.session.view.opener
        view = self.session.start_hand(tiles, opener=opener)
        self.write(f"mano registrada; sale {view.name(view.opener)}")
        if view.forced_open_tile:
            self.write(f"debe abrir con [{view.forced_open_tile}]")
        self.write(render_seats(view))

    # ---------------------------------------------------------------- play
    def cmd_play(self, args: Sequence[str]) -> None:
        if len(args) < 2:
            raise SessionError("uso: juega <jugador> <ficha> [izq|der]")
        seat = self.seat(args[0])
        tile = Tile.parse(args[1])
        end = self.end(args[2]) if len(args) > 2 else None
        play = self.session.play(seat, tile, end)
        view = self.session.require_view()
        self.write(f"{view.name(seat)} juega [{tile}] "
                   f"({'izquierda' if play.end is End.LEFT else 'derecha'})"
                   f"   puntas: {view.ends[0]} / {view.ends[1]}")
        self.after_move()

    def cmd_pass(self, args: Sequence[str]) -> None:
        if not args:
            raise SessionError("uso: paso <jugador>")
        seat = self.seat(args[0])
        self.session.passes(seat)
        view = self.session.require_view()
        self.write(f"{view.name(seat)} pasa (no tiene {view.ends[0]} ni {view.ends[1]})")
        self.after_move()

    def cmd_undo(self, args: Sequence[str]) -> None:
        move = self.session.undo()
        self.write(f"deshecho: {move}" if move else "no hay nada que deshacer")

    def after_move(self) -> None:
        view = self.session.require_view()
        if view.is_over():
            if view.domino_player() is not None:
                self.write(f"¡{view.name(view.domino_player())} se pegó! "
                           "cierra con 'fin puntos ...' o 'fin fichas ...'")
            else:
                self.write("¡tranque! cierra con 'fin puntos ...' o 'fin fichas ...'")
            return
        if self.auto:
            self.write(self.short_read(view))

    def short_read(self, view: TableView) -> str:
        pos = evaluate_position(view, config=LIVE, match=self.session.match,
                                analyse_all_seats=False)
        best = pos.best.describe() if pos.best else "(le toca a otro)"
        return (render_bar(pos, view) + "\n"
                f"le toca a {view.name(view.turn)}: {best}")

    # ---------------------------------------------------------------- views
    def cmd_board(self, args: Sequence[str]) -> None:
        view = self.session.require_view()
        self.write(render_chain(view))
        self.write("")
        try:
            beliefs = build_beliefs(view)
        except InconsistentObservations as exc:
            beliefs = None
            self.write(f"(no puedo calcular probabilidades: {exc})")
        self.write(render_seats(view, beliefs))

    def cmd_eval(self, args: Sequence[str]) -> None:
        view = self.session.require_view()
        config = self.config
        if args:
            key = args[0].lower()
            config = {"rapido": FAST, "rápido": FAST, "fast": FAST,
                      "hondo": DEEP, "deep": DEEP}.get(key, self.config)
        pos = evaluate_position(view, config=config, match=self.session.match)
        self.write(render_position(view, pos))

    def cmd_bar(self, args: Sequence[str]) -> None:
        view = self.session.require_view()
        pos = evaluate_position(view, config=self.config,
                                match=self.session.match,
                                analyse_all_seats=False)
        self.write(render_bar(pos, view))
        self.write(pos.tranque.describe())

    def cmd_beliefs(self, args: Sequence[str]) -> None:
        view = self.session.require_view()
        limit = int(args[0]) if args and args[0].isdigit() else None
        self.write(render_beliefs(view, build_beliefs(view), limit))

    def cmd_hint(self, args: Sequence[str]) -> None:
        view = self.session.require_view()
        seat = self.seat(args[0]) if args else view.turn
        from .search import evaluate_moves
        evals = evaluate_moves(view, seat, self.config,
                               hypothetical=seat != view.turn)
        self.write(rule(f"jugadas de {view.name(seat)}"))
        self.write(render_moves(evals))

    # ---------------------------------------------------------------- close
    def cmd_end(self, args: Sequence[str]) -> None:
        if not args:
            raise SessionError(
                "uso: fin puntos <p0> <p1> <p2> <p3>  |  fin fichas <jugador>=<fichas> ...")
        mode = args[0].lower()
        if mode in ("puntos", "pips", "points"):
            pips = [int(x) for x in args[1:]]
            result = self.session.finish_hand(pips=pips)
        elif mode in ("fichas", "tiles", "reveal"):
            revealed: dict[int, list[Tile]] = {}
            for chunk in " ".join(args[1:]).split(";"):
                if not chunk.strip():
                    continue
                who, _, tiles = chunk.partition("=")
                revealed[self.seat(who)] = parse_tiles(tiles)
            result = self.session.finish_hand(revealed=revealed)
        else:
            raise SessionError("¿'fin puntos ...' o 'fin fichas ...'?")
        self.write(result.describe())
        for note in result.notes:
            self.write("  " + note)
        self.write(render_match(self.session.match))

    def cmd_score(self, args: Sequence[str]) -> None:
        self.write(render_match(self.session.match))

    def cmd_save(self, args: Sequence[str]) -> None:
        if not args:
            raise SessionError("uso: guardar <archivo>")
        path = self.session.save(args[0])
        self.write(f"guardado en {path}")

    def cmd_load(self, args: Sequence[str]) -> None:
        if not args:
            raise SessionError("uso: cargar <archivo>")
        self.session = Session.load(args[0])
        self.write(f"cargado {args[0]}")
        self.write(render_match(self.session.match))

    def cmd_auto(self, args: Sequence[str]) -> None:
        self.auto = not args or args[0].lower() in ("on", "sí", "si", "1")
        self.write(f"análisis automático: {'on' if self.auto else 'off'}")

    def cmd_rules(self, args: Sequence[str]) -> None:
        rules = self.session.rules
        self.write(f"partida a {rules.target_score}; "
                   f"cuenta {rules.hand_points.value}; "
                   f"tranque {rules.tranque_winner.value}, "
                   f"empate {rules.tranque_tie.value}; "
                   f"capicúa {rules.capicua_bonus}, chuchazo {rules.chuchazo_bonus}, "
                   f"paso corrido {rules.paso_corrido_bonus}")
        self.write("presets: " + ", ".join(sorted(PRESETS)))

    def cmd_quit(self, args: Sequence[str]) -> None:
        raise EOFError


COMMANDS = {
    "ayuda": Console.cmd_help, "help": Console.cmd_help, "?": Console.cmd_help,
    "nueva": Console.cmd_new, "new": Console.cmd_new,
    "nombres": Console.cmd_names, "names": Console.cmd_names,
    "soy": Console.cmd_hero, "hero": Console.cmd_hero,
    "asiento": Console.cmd_hero,
    "salida": Console.cmd_open, "open": Console.cmd_open,
    "mano": Console.cmd_deal, "deal": Console.cmd_deal,
    "juega": Console.cmd_play, "play": Console.cmd_play, "j": Console.cmd_play,
    "paso": Console.cmd_pass, "pass": Console.cmd_pass, "x": Console.cmd_pass,
    "deshacer": Console.cmd_undo, "undo": Console.cmd_undo,
    "mesa": Console.cmd_board, "board": Console.cmd_board,
    "eval": Console.cmd_eval, "analisis": Console.cmd_eval,
    "análisis": Console.cmd_eval,
    "barra": Console.cmd_bar, "bar": Console.cmd_bar,
    "fichas": Console.cmd_beliefs, "beliefs": Console.cmd_beliefs,
    "sugerencia": Console.cmd_hint, "hint": Console.cmd_hint,
    "fin": Console.cmd_end, "end": Console.cmd_end,
    "puntos": Console.cmd_score, "score": Console.cmd_score,
    "guardar": Console.cmd_save, "save": Console.cmd_save,
    "cargar": Console.cmd_load, "load": Console.cmd_load,
    "auto": Console.cmd_auto,
    "reglas": Console.cmd_rules, "rules": Console.cmd_rules,
    "salir": Console.cmd_quit, "quit": Console.cmd_quit, "exit": Console.cmd_quit,
}


def repl(console: Console, stream=None) -> None:
    stream = stream or sys.stdin
    interactive = stream.isatty() if hasattr(stream, "isatty") else False
    if interactive:
        console.write(BANNER)
    while True:
        if interactive:
            print("> ", end="", flush=True)
        line = stream.readline()
        if not line:
            break
        line = line.strip()
        if line.startswith("#") or not line:
            continue
        if not interactive:
            console.write(f"> {line}")
        try:
            console.run(line)
        except EOFError:
            break
        except (SessionError, IllegalMove, ValueError,
                InconsistentObservations) as exc:
            console.write(f"⚠ {exc}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="dominord", description="motor de dominó dominicano")
    sub = parser.add_subparsers(dest="command")
    live = sub.add_parser("mesa", help="consola para reconstruir una partida")
    live.add_argument("--rules", default="patio", choices=sorted(PRESETS))
    live.add_argument("--names", nargs=4,
                      default=["Yo", "Der", "Socio", "Izq"])
    live.add_argument("--hero", type=int, default=0)
    live.add_argument("--load")
    demo = sub.add_parser("selfplay", help="el motor juega contra sí mismo")
    demo.add_argument("--matches", type=int, default=1)
    demo.add_argument("--rules", default="patio", choices=sorted(PRESETS))
    demo.add_argument("--seed", type=int, default=0)
    demo.add_argument("--greedy-rivals", action="store_true",
                      help="la pareja 1 juega con la política simple")
    args = parser.parse_args(argv)

    if args.command == "selfplay":
        return _run_selfplay(args)
    session = (Session.load(args.load) if getattr(args, "load", None)
               else Session(rules=preset(getattr(args, "rules", "patio")),
                            player_names=tuple(getattr(
                                args, "names", ["Yo", "Der", "Socio", "Izq"])),
                            hero=getattr(args, "hero", 0)))
    repl(Console(session=session))
    return 0


def _run_selfplay(args) -> int:
    rules = preset(args.rules)
    rng = random.Random(args.seed)
    wins = [0, 0]
    for i in range(args.matches):
        choosers = [engine_chooser(FAST) for _ in range(rules.players)]
        if args.greedy_rivals:
            choosers[1] = greedy_chooser(args.seed + i)
            choosers[3] = greedy_chooser(args.seed + i + 1000)
        match = play_match(rules=rules, choosers=choosers, rng=rng)
        champion = match.winner()
        if champion is not None:
            wins[champion] += 1
        print(f"partida {i + 1}: {match.summary()}")
        for result in match.results:
            print("   " + result.describe())
    if args.matches > 1:
        print(f"\nparejas: {wins[0]} - {wins[1]}")
    return 0
