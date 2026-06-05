import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, Text, View, Dimensions, TouchableOpacity, ScrollView } from 'react-native';
import { BarChart } from 'react-native-chart-kit';
import { Accelerometer } from 'expo-sensors';
import { StatusBar } from 'expo-status-bar';
import Svg, { Circle } from 'react-native-svg';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withRepeat, 
  withTiming, 
  withSequence, 
  Easing 
} from 'react-native-reanimated';
import * as SQLite from 'expo-sqlite';

const STRIDE_LENGTH_METERS = 0.70;
// Thresholds in m/s^2
const STEP_THRESHOLD = 11.2; 
const RESET_THRESHOLD = 10.0;
const MAX_SHAKE_THRESHOLD = 25.0; // Filter out violent shaking
const DEBOUNCE_MS = 300;
const GOAL_STEPS = 1000;

const { width, height } = Dimensions.get('window');
const RING_SIZE = width * 0.8;
const RING_STROKE_WIDTH = 12;
const RING_RADIUS = (RING_SIZE - RING_STROKE_WIDTH) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// 1. Database Setup: Initialize SQLite database connection
const db = SQLite.openDatabaseSync('stepTracker.db');

// Ensure table exists with id, date (Unique), and step_count
db.execSync(`
  CREATE TABLE IF NOT EXISTS daily_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE,
    step_count INTEGER DEFAULT 0
  );
`);

// Helper to get current date as YYYY-MM-DD
const getTodayString = () => {
  const today = new Date();
  return today.toISOString().split('T')[0];
};

export default function AccelerometerStepCounter() {
  const [steps, setSteps] = useState(0);
  const [history, setHistory] = useState<{date: string, step_count: number}[]>([]);
  const stepCountRef = useRef(0);
  const isSteppingRef = useRef(false);
  const lastStepTimeRef = useRef(0);
  const [subscription, setSubscription] = useState<any>(null);

  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(false);

  const toggleTracking = () => {
    setIsRunning(!isRunning);
    isRunningRef.current = !isRunning;
  };

  // Animation values
  const idleScale = useSharedValue(1);
  const popScale = useSharedValue(1);

  useEffect(() => {
    // 2. Load on Start: Fetch step_count for the current date from the database
    const loadInitialSteps = async () => {
      const today = getTodayString();
      try {
        const row = await db.getFirstAsync<{step_count: number}>(
          `SELECT step_count FROM daily_steps WHERE date = ?`, 
          [today]
        );
        if (row) {
          stepCountRef.current = row.step_count;
          setSteps(row.step_count);
        } else {
          await db.runAsync(
            `INSERT INTO daily_steps (date, step_count) VALUES (?, ?)`, 
            [today, 0]
          );
        }

        const historyRows = await db.getAllAsync<{date: string, step_count: number}>(
          `SELECT date, step_count FROM daily_steps ORDER BY date DESC LIMIT 7`
        );
        historyRows.reverse();
        setHistory(historyRows);

      } catch (error) {
        console.error("Failed to load DB", error);
      }
    };
    loadInitialSteps();

    // Breathing idle animation
    idleScale.value = withRepeat(
      withTiming(1.05, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
      -1, 
      true
    );
  }, []);

  const triggerStepPop = () => {
    // Impact pop animation when step is detected
    popScale.value = withSequence(
      withTiming(1.15, { duration: 80, easing: Easing.out(Easing.ease) }),
      withTiming(1.0, { duration: 300, easing: Easing.in(Easing.ease) })
    );
  };

  useEffect(() => {
    // Set the update interval to 100ms
    Accelerometer.setUpdateInterval(100);

    const subscribe = () => {
      const sub = Accelerometer.addListener(accelerometerData => {
        if (!isRunningRef.current) return;
        const { x, y, z } = accelerometerData;
        
        // Convert to m/s^2
        const x_m = x * 9.81;
        const y_m = y * 9.81;
        const z_m = z * 9.81;
        
        const magnitude = Math.sqrt(x_m * x_m + y_m * y_m + z_m * z_m);
        const currentTime = Date.now();

        // Step Detection Logic (ignoring violent shakes > MAX_SHAKE_THRESHOLD)
        if (magnitude > STEP_THRESHOLD && magnitude < MAX_SHAKE_THRESHOLD) {
          isSteppingRef.current = true;
        } else if (magnitude < RESET_THRESHOLD && isSteppingRef.current) {
          if (currentTime - lastStepTimeRef.current > DEBOUNCE_MS) {
            stepCountRef.current += 1;
            setSteps(stepCountRef.current);
            lastStepTimeRef.current = currentTime;
            
            // 3. Background Saving: Update DB record for today's date
            db.runAsync(
              `UPDATE daily_steps SET step_count = ? WHERE date = ?`, 
              [stepCountRef.current, getTodayString()]
            ).catch(console.error);

            // Trigger step animation
            triggerStepPop();
          }
          isSteppingRef.current = false;
        } else if (magnitude >= MAX_SHAKE_THRESHOLD) {
          // If it's a violent shake, cancel the current step detection cycle
          isSteppingRef.current = false;
        }
      });
      setSubscription(sub);
    };

    subscribe();

    return () => {
      if (subscription) {
        subscription.remove();
      }
    };
  }, []);

  const resetSteps = () => {
    stepCountRef.current = 0;
    setSteps(0);
    
    // Background Saving: reset DB for today
    db.runAsync(
      `UPDATE daily_steps SET step_count = 0 WHERE date = ?`, 
      [getTodayString()]
    ).catch(console.error);

    // Optional pop feedback on reset
    triggerStepPop();
  };

  const distanceKm = (steps * STRIDE_LENGTH_METERS) / 1000;
  
  // Progress Ring logic
  const progress = Math.min(steps / GOAL_STEPS, 1);
  const strokeDashoffset = RING_CIRCUMFERENCE - (RING_CIRCUMFERENCE * progress);

  // Combine breathing and pop animations
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: idleScale.value * popScale.value }]
  }));

  const chartLabels = history.map(h => {
    const [year, month, day] = h.date.split('-');
    const d = new Date(Number(year), Number(month) - 1, Number(day));
    return d.toLocaleDateString('en-US', { weekday: 'short' });
  });

  const todayStr = getTodayString();
  const chartDataValues = history.map(h => h.date === todayStr ? steps : h.step_count);

  const chartData = {
    labels: chartLabels.length > 0 ? chartLabels : ['Today'],
    datasets: [{ data: chartDataValues.length > 0 ? chartDataValues : [steps] }]
  };

  return (
    <ScrollView 
      style={styles.mainScroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.container}>
      <StatusBar style="light" />
      
      <TouchableOpacity style={styles.resetButton} onPress={resetSteps} activeOpacity={0.6}>
        <Text style={styles.resetButtonText}>RESET</Text>
      </TouchableOpacity>
      
      <Animated.View style={[styles.ringContainer, animatedStyle]}>
        <Svg width={RING_SIZE} height={RING_SIZE}>
          {/* Background Track - Lightened to be clearly visible */}
          <Circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            stroke="#330000"
            strokeWidth={RING_STROKE_WIDTH}
            fill="none"
          />
          {/* Progress Ring */}
          <Circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            stroke="#FF0000"
            strokeWidth={RING_STROKE_WIDTH}
            fill="none"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            rotation="-90"
            origin={`${RING_SIZE / 2}, ${RING_SIZE / 2}`}
          />
        </Svg>
        
        <View style={styles.centerData}>
          <Text style={styles.stepLabel}>STEPS</Text>
          <Text style={styles.stepCount}>{steps}</Text>
        </View>
      </Animated.View>

      <View style={styles.bottomData}>
        <Text style={styles.distanceValue}>{distanceKm.toFixed(2)}</Text>
        <Text style={styles.distanceLabel}>KM</Text>
      </View>

      <TouchableOpacity 
        style={[styles.actionButton, isRunning ? styles.stopButton : styles.startButton]} 
        onPress={toggleTracking}
        activeOpacity={0.8}
      >
        <Text style={styles.actionButtonText}>
          {isRunning ? 'STOP' : 'START'}
        </Text>
      </TouchableOpacity>
      </View>

      <View style={styles.chartContainer}>
        <Text style={styles.chartTitle}>PREVIOUS MISSIONS</Text>
        <BarChart
          data={chartData}
          width={width * 0.9}
          height={220}
          yAxisLabel=""
          yAxisSuffix=""
          fromZero={true}
          withHorizontalLabels={false}
          showValuesOnTopOfBars={true}
          chartConfig={{
            backgroundColor: '#000000',
            backgroundGradientFrom: '#000000',
            backgroundGradientTo: '#000000',
            decimalPlaces: 0,
            color: (opacity = 1) => `rgba(255, 0, 0, ${opacity})`,
            labelColor: (opacity = 1) => `rgba(255, 0, 0, ${opacity})`,
            style: {
              borderRadius: 16,
            },
            propsForBackgroundLines: {
              strokeWidth: 1,
              stroke: '#330000',
              strokeDasharray: '0',
            },
          }}
          style={{
            marginVertical: 8,
            borderRadius: 16,
          }}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  mainScroll: {
    flex: 1,
    backgroundColor: '#000000',
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
  },
  container: {
    height: height,
    width: width,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  chartContainer: {
    width: width,
    alignItems: 'center',
    paddingBottom: 60,
    backgroundColor: '#000000',
  },
  chartTitle: {
    color: '#FF0000',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 4,
    marginBottom: 20,
    alignSelf: 'center',
  },
  resetButton: {
    position: 'absolute',
    top: 60,
    right: 30,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#FF0000',
    backgroundColor: 'transparent',
  },
  resetButtonText: {
    color: '#FF0000',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 2,
  },
  ringContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerData: {
    position: 'absolute',
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepLabel: {
    color: '#FF0000',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 6,
    marginBottom: 5,
  },
  stepCount: {
    color: '#FF0000',
    fontSize: 90,
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(255, 0, 0, 0.6)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 15,
  },
  bottomData: {
    position: 'absolute',
    bottom: 120,
    alignItems: 'center',
  },
  distanceValue: {
    color: '#FF0000',
    fontSize: 52,
    fontWeight: 'bold',
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(255, 0, 0, 0.4)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10,
  },
  distanceLabel: {
    color: '#FF0000',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 4,
    marginTop: -5,
  },
  actionButton: {
    position: 'absolute',
    bottom: 40,
    width: width * 0.8,
    paddingVertical: 18,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
  },
  startButton: {
    borderColor: '#FF0000',
    backgroundColor: 'transparent',
  },
  stopButton: {
    borderColor: '#330000',
    backgroundColor: '#1a0000',
  },
  actionButtonText: {
    color: '#FF0000',
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 4,
  }
});
