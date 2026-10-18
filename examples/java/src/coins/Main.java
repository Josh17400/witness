// Coins for Java: witness mode when launched by the Witness CLI, otherwise a real-time Swing window
// (arrows/WASD to move, F8 marks the replay, Esc quits). Set WITNESS_RECORD=run.jsonl to record a
// replay that `witness replay run.jsonl` plays back.
package coins;

import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.GraphicsEnvironment;
import java.awt.event.KeyAdapter;
import java.awt.event.KeyEvent;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.awt.image.BufferedImage;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.swing.JFrame;
import javax.swing.JPanel;
import javax.swing.SwingUtilities;
import javax.swing.Timer;
import witness.Witness;

public final class Main {
    private Main() {}

    public static void main(String[] args) {
        CoinsGame game = new CoinsGame();
        Witness.Hello hello = new Witness.Hello("Coins (Java)")
            .engine("plain Java")
            .fps(CoinsGame.FPS)
            .size(CoinsGame.WIDTH, CoinsGame.HEIGHT)
            .call("teleport", "x y", "move the player")
            .call("addcoin", "x y", "add a coin, returns the coin count")
            .keys("left", "right", "up", "down", "w", "a", "s", "d");
        Witness.Handlers handlers = new Witness.Handlers()
            .reset((seed, scene, params) -> game.reset(seed))
            .input(game::apply)
            .step(game::step)
            .snapshot(game::snapshot)
            .screenshot(scale -> game.render())
            .call(game::call)
            .perf(() -> {
                Map<String, Object> counts = new LinkedHashMap<>();
                counts.put("coins", game.coinsLeft());
                Map<String, Object> perf = new LinkedHashMap<>();
                perf.put("counts", counts);
                return perf;
            });

        if (Witness.active(args)) {
            Witness.pcm(new Witness.Pcm(CoinsGame.SAMPLE_RATE, 1));   // before start, so hello advertises "audio"
            if (!Witness.start(hello, handlers)) System.exit(1);
            Witness.run(handlers);
            return;
        }

        if (GraphicsEnvironment.isHeadless()) {
            System.err.println("Coins needs a display for real-time play. To drive it headless, use the Witness CLI (witness test / doctor).");
            System.exit(2);
        }
        Witness.start(hello, null);   // starts recording when WITNESS_RECORD is set
        game.reset(Witness.seed());
        SwingUtilities.invokeLater(() -> new Window(game).open());
    }

    /** Real-time play: a 3x-scaled view of the same pixels the screenshot handler returns. */
    private static final class Window extends JPanel {
        private static final long serialVersionUID = 1L;
        private static final int SCALE = 3;
        private static final Map<Integer, String> KEYS = new HashMap<>();

        static {
            KEYS.put(KeyEvent.VK_LEFT, "left");
            KEYS.put(KeyEvent.VK_RIGHT, "right");
            KEYS.put(KeyEvent.VK_UP, "up");
            KEYS.put(KeyEvent.VK_DOWN, "down");
            KEYS.put(KeyEvent.VK_W, "w");
            KEYS.put(KeyEvent.VK_A, "a");
            KEYS.put(KeyEvent.VK_S, "s");
            KEYS.put(KeyEvent.VK_D, "d");
            KEYS.put(KeyEvent.VK_SPACE, "space");
        }

        private final transient CoinsGame game;
        private final transient List<Witness.Event> pending = new ArrayList<>();
        private final Set<String> down = new HashSet<>();
        private final BufferedImage frame = new BufferedImage(CoinsGame.WIDTH, CoinsGame.HEIGHT, BufferedImage.TYPE_INT_ARGB);
        private long last = System.nanoTime();

        Window(CoinsGame game) {
            this.game = game;
            setPreferredSize(new Dimension(CoinsGame.WIDTH * SCALE, CoinsGame.HEIGHT * SCALE));
            setFocusable(true);
            addKeyListener(new KeyAdapter() {
                @Override public void keyPressed(KeyEvent e) { key(e, true); }
                @Override public void keyReleased(KeyEvent e) { key(e, false); }
            });
        }

        void open() {
            JFrame f = new JFrame("Coins" + (Witness.recording() ? "  [recording]" : ""));
            f.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
            f.addWindowListener(new WindowAdapter() {
                @Override public void windowClosed(WindowEvent e) { quit(); }
            });
            f.add(this);
            f.pack();
            f.setResizable(false);
            f.setLocationRelativeTo(null);
            f.setVisible(true);
            requestFocusInWindow();
            new Timer(1000 / CoinsGame.FPS, e -> tick()).start();
        }

        private void key(KeyEvent e, boolean isDown) {
            if (isDown && e.getKeyCode() == KeyEvent.VK_ESCAPE) { quit(); return; }
            if (isDown && e.getKeyCode() == KeyEvent.VK_F8) { Witness.mark("F8"); return; }
            String name = KEYS.get(e.getKeyCode());
            if (name == null) return;
            if (isDown ? down.add(name) : down.remove(name)) pending.add(Witness.Event.key(name, isDown));   // drop OS auto-repeat
        }

        private void tick() {
            long now = System.nanoTime();
            double dt = Math.min(0.1, (now - last) / 1e9);
            last = now;
            List<Witness.Event> events = new ArrayList<>(pending);
            pending.clear();
            for (Witness.Event e : events) game.apply(e);
            game.step(dt);
            Witness.recordFrame(dt, events);
            repaint();
        }

        @Override protected void paintComponent(Graphics g) {
            byte[] rgba = game.render().rgba;
            int[] argb = new int[CoinsGame.WIDTH * CoinsGame.HEIGHT];
            for (int p = 0; p < argb.length; p++)
                argb[p] = 0xff000000 | (rgba[p * 4] & 0xff) << 16 | (rgba[p * 4 + 1] & 0xff) << 8 | (rgba[p * 4 + 2] & 0xff);
            frame.setRGB(0, 0, CoinsGame.WIDTH, CoinsGame.HEIGHT, argb, 0, CoinsGame.WIDTH);
            g.drawImage(frame, 0, 0, getWidth(), getHeight(), null);
            g.setColor(java.awt.Color.WHITE);
            g.drawString("score " + game.score() + "   arrows/WASD move, F8 mark, Esc quit", 8, 16);
        }

        private static void quit() {
            Witness.stopRecording();
            System.exit(0);
        }
    }
}
