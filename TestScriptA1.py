import random
import tkinter as tk


WINDOW_WIDTH = 900
WINDOW_HEIGHT = 600
TEXT = "Hello World"
FONT = ("Arial", 36, "bold")
BG_COLOR = "black"
TEXT_COLORS = [
    "#ffffff",
    "#ff4d4d",
    "#4dd2ff",
    "#7dff7d",
    "#ffd24d",
    "#ff66ff",
]
FRAME_DELAY_MS = 16
PADDING = 10


class BouncingHelloWorld:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("TestScriptA1")
        self.root.configure(bg=BG_COLOR)
        self.root.resizable(False, False)

        self.canvas = tk.Canvas(
            root,
            width=WINDOW_WIDTH,
            height=WINDOW_HEIGHT,
            bg=BG_COLOR,
            highlightthickness=0,
        )
        self.canvas.pack()

        self.text_id = self.canvas.create_text(
            WINDOW_WIDTH // 2,
            WINDOW_HEIGHT // 2,
            text=TEXT,
            fill=random.choice(TEXT_COLORS),
            font=FONT,
        )

        bbox = self.canvas.bbox(self.text_id)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]

        self.vx = 5
        self.vy = 4
        self.max_x = WINDOW_WIDTH - text_width / 2 - PADDING
        self.min_x = text_width / 2 + PADDING
        self.max_y = WINDOW_HEIGHT - text_height / 2 - PADDING
        self.min_y = text_height / 2 + PADDING

        self.animate()

    def animate(self) -> None:
        x, y = self.canvas.coords(self.text_id)
        next_x = x + self.vx
        next_y = y + self.vy
        bounced = False

        if next_x >= self.max_x or next_x <= self.min_x:
            self.vx *= -1
            next_x = max(self.min_x, min(self.max_x, next_x))
            bounced = True

        if next_y >= self.max_y or next_y <= self.min_y:
            self.vy *= -1
            next_y = max(self.min_y, min(self.max_y, next_y))
            bounced = True

        if bounced:
            self.canvas.itemconfig(self.text_id, fill=random.choice(TEXT_COLORS))

        self.canvas.coords(self.text_id, next_x, next_y)
        self.root.after(FRAME_DELAY_MS, self.animate)


def main() -> None:
    root = tk.Tk()
    BouncingHelloWorld(root)
    root.mainloop()


if __name__ == "__main__":
    main()
